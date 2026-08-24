// ===== State =====
let settings = {};
let accounts = [];
const statuses = {};      // accountId -> 'online' | 'connecting' | 'offline'
let selectedAccountId = 'all';  // console/inventory target, shared with the Accounts list
let leaderboard = { entries: [], updatedAt: 0 };
let wall = {
  active: false, raidActive: false, lastCheckAt: 0, totalChecks: 0,
  top: [], roster: [], accountOnline: false,
};
let ws = null;

const $ = (id) => document.getElementById(id);
const api = (path, opts = {}) =>
  fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts })
    .then(async (r) => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
      return data;
    });

// ===== Boot =====
init();
async function init() {
  try {
    const status = await api('/auth/status');
    if (status.authed) return showApp();
  } catch { /* fall through to unlock screen */ }
  showAuth();
}

function showAuth() {
  $('auth-screen').classList.remove('hidden');
  $('app').classList.add('hidden');
  $('auth-password').focus();
}

async function showApp() {
  $('auth-screen').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('user-email').textContent = 'Local session';
  settings = await api('/api/settings');
  accounts = await api('/api/accounts');
  renderSettings();
  renderAccounts();
  renderLeaderboard();
  renderWallBot();
  updateAccountForm();
  routeFromHash();
  connectWs();
}

// ===== View routing =====
// Both views live in the same document; only their visibility changes, so one WebSocket and
// one copy of the render code serve both. The hash is the single source of truth for which
// view is active — tabs set it, and the hashchange handler does the switching.
const VIEWS = ['bots', 'wall'];

function showView(name) {
  const active = VIEWS.includes(name) ? name : 'bots';
  for (const view of VIEWS) $(`view-${view}`).classList.toggle('hidden', view !== active);
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.setAttribute('aria-selected', tab.dataset.view === active ? 'true' : 'false');
  });
}

function routeFromHash() { showView(location.hash.replace(/^#/, '')); }

window.addEventListener('hashchange', routeFromHash);
document.querySelectorAll('.tab').forEach((tab) => {
  // Setting the hash fires hashchange, which switches the view — and makes the browser's
  // back button move between views for free. Both views get an explicit hash: assigning an
  // empty string doesn't reliably fire hashchange, so "#bots" is used rather than clearing it.
  tab.onclick = () => { location.hash = tab.dataset.view; };
});

// ===== Auth actions =====
$('auth-submit').onclick = unlock;
$('auth-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
async function unlock() {
  $('auth-error').textContent = '';
  try {
    await api('/auth/login', { method: 'POST', body: JSON.stringify({ password: $('auth-password').value }) });
    $('auth-password').value = '';
    await showApp();
  } catch (e) {
    $('auth-error').textContent = e.message;
  }
}
$('logout-btn').onclick = async () => {
  await api('/auth/logout', { method: 'POST' });
  if (ws) ws.close();
  location.reload();
};

// ===== WebSocket =====
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onmessage = (ev) => handleWs(JSON.parse(ev.data));
  ws.onclose = () => { setTimeout(() => { if (!$('app').classList.contains('hidden')) connectWs(); }, 2000); };
}
function wsSend(msg) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }

function handleWs(msg) {
  switch (msg.type) {
    case 'statusSnapshot':
      Object.assign(statuses, msg.statuses);
      renderAccounts();
      break;
    case 'botStatus':
      statuses[msg.accountId] = msg.status;
      renderAccounts();
      break;
    case 'onlineCount':
      $('online-count').textContent = `Online: ${msg.online}/${msg.total}`;
      break;
    case 'consoleLine':
      appendConsole(msg);
      break;
    case 'accountAdded':
      hideMsaModal();
      refreshAccounts();
      break;
    case 'msaCode':
      showMsaModal(msg.code);
      break;
    case 'leaderboard':
      leaderboard = { entries: msg.entries || [], updatedAt: msg.updatedAt || Date.now() };
      renderLeaderboard();
      break;
    case 'wallState':
      wall = {
        active: !!msg.active,
        raidActive: !!msg.raidActive,
        lastCheckAt: msg.lastCheckAt || 0,
        totalChecks: msg.totalChecks || 0,
        top: msg.top || [],
        roster: msg.roster || [],
        accountOnline: !!msg.accountOnline,
      };
      renderWallBot();
      break;
    case 'error':
      appendConsole({ text: msg.message, error: true });
      break;
  }
}

// ===== Accounts =====
async function refreshAccounts() {
  accounts = await api('/api/accounts');
  renderAccounts();
}

function statusInfo(acc) {
  const s = statuses[acc.id];
  if (s === 'online') return { cls: 'online', dot: 'online', text: 'online' };
  if (s === 'connecting') return { cls: 'connecting', dot: 'connecting', text: 'connecting' };
  if (acc.load_enabled) return { cls: '', dot: 'enabled', text: 'ready' };
  return { cls: '', dot: '', text: 'off' };
}

function renderAccounts() {
  const list = $('account-list');
  list.innerHTML = '';

  if (accounts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'account-empty';
    empty.textContent = 'No accounts yet — add one above.';
    list.appendChild(empty);
  }

  for (const acc of accounts) {
    const info = statusInfo(acc);
    const row = document.createElement('div');
    row.className = 'account-row' + (selectedAccountId === acc.id ? ' selected' : '');
    row.onclick = () => setTarget(acc.id);

    const dot = document.createElement('span');
    dot.className = 'status-dot ' + info.dot;
    dot.title = acc.load_enabled ? 'Loaded — click to unload' : 'Not loaded — click to load';
    dot.onclick = (e) => { e.stopPropagation(); toggleLoad(acc); };

    const name = document.createElement('span');
    name.className = 'account-name';
    name.textContent = acc.label || acc.username;

    const tag = document.createElement('span');
    tag.className = 'account-tag';
    tag.textContent = acc.auth_type === 'microsoft' ? 'MS' : 'offline';

    const status = document.createElement('span');
    status.className = 'account-status ' + info.cls;
    status.textContent = info.text;

    // Per-account connect/disconnect (footer buttons still act on all).
    const live = statuses[acc.id] === 'online' || statuses[acc.id] === 'connecting';
    const power = document.createElement('button');
    power.className = 'account-power' + (live ? ' on' : '');
    power.textContent = live ? '⏻' : '▶';
    power.title = live ? 'Disconnect this account' : 'Connect this account';
    power.onclick = (e) => {
      e.stopPropagation();
      wsSend({ type: live ? 'disconnect' : 'connect', accountIds: [acc.id] });
    };

    const del = document.createElement('button');
    del.className = 'account-del';
    del.textContent = '×';
    del.title = 'Remove account';
    del.onclick = (e) => { e.stopPropagation(); deleteAccount(acc); };

    row.append(dot, name, tag, status, power, del);
    list.appendChild(row);
  }

  // Header: count + select-all state.
  $('account-count').textContent = `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;
  const enabledCount = accounts.filter((a) => a.load_enabled).length;
  const cb = $('select-all');
  cb.checked = accounts.length > 0 && enabledCount === accounts.length;
  cb.indeterminate = enabledCount > 0 && enabledCount < accounts.length;

  renderConsoleTargets();
  renderLeaderboardAccountOptions();
}

// Focus an account (or 'all') across the Accounts list + Console dropdown.
function setTarget(id) {
  selectedAccountId = id;
  renderAccounts();
  applyConsoleFilter();
}

$('select-all').onchange = async (e) => {
  accounts = await api('/api/accounts/load-all', {
    method: 'POST', body: JSON.stringify({ enabled: e.target.checked }),
  });
  renderAccounts();
};

async function toggleLoad(acc) {
  const updated = await api(`/api/accounts/${acc.id}/load`, {
    method: 'POST', body: JSON.stringify({ enabled: !acc.load_enabled }),
  });
  acc.load_enabled = updated.load_enabled;
  renderAccounts();
}

async function deleteAccount(acc) {
  await api(`/api/accounts/${acc.id}`, { method: 'DELETE' });
  accounts = accounts.filter((a) => a.id !== acc.id);
  delete statuses[acc.id];
  renderAccounts();
}

$('add-account').onclick = addAccount;
async function addAccount() {
  const offline = !!settings.offline_mode;
  try {
    if (offline) {
      const username = $('acc-input1').value.trim();
      const acc = await api('/api/accounts', {
        method: 'POST', body: JSON.stringify({ authType: 'offline', username }),
      });
      accounts.push(acc);
      $('acc-input1').value = '';
      renderAccounts();
    } else {
      $('acc-hint').textContent = 'Starting Microsoft sign-in…';
      await api('/api/accounts', {
        method: 'POST', body: JSON.stringify({ authType: 'microsoft' }),
      });
      // Completion arrives via WS (msaCode -> accountAdded).
    }
  } catch (e) {
    $('acc-hint').textContent = e.message;
  }
}

function updateAccountForm() {
  const offline = !!settings.offline_mode;
  if (offline) {
    $('acc-label1').textContent = 'Username';
    $('acc-input1').disabled = false;
    $('acc-input1').placeholder = 'Notch';
    $('acc-hint').textContent = 'Offline/cracked mode: add by username.';
  } else {
    $('acc-label1').textContent = 'Microsoft account';
    $('acc-input1').disabled = true;
    $('acc-input1').placeholder = '';
    $('acc-hint').textContent = 'Click ＋ to sign in with Microsoft.';
  }
}

// ===== Connect / Disconnect =====
$('connect-btn').onclick = () => wsSend({ type: 'connect' });
$('disconnect-btn').onclick = () => wsSend({ type: 'disconnect' });

// ===== Settings =====
function renderSettings() {
  document.querySelectorAll('[data-setting]').forEach((el) => {
    const key = el.dataset.setting;
    if (el.classList.contains('toggle')) {
      el.setAttribute('aria-pressed', settings[key] ? 'true' : 'false');
    } else {
      el.value = settings[key] ?? '';
    }
  });
}

let saveTimer = null;
let pendingPatch = {};
function saveSettings(patch) {
  Object.assign(settings, patch);
  Object.assign(pendingPatch, patch);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const body = pendingPatch;
    pendingPatch = {};
    const saved = await api('/api/settings', { method: 'PUT', body: JSON.stringify(body) });
    // Merge the server's canonical values, but keep any edits made while the
    // request was in flight (they live in the new pendingPatch / local settings).
    settings = { ...saved, ...pendingPatch };
  }, 250);
}

document.querySelectorAll('input[data-setting], textarea[data-setting], select[data-setting]').forEach((el) => {
  const save = () => saveSettings({ [el.dataset.setting]: el.value });
  el.addEventListener('input', save);
  el.addEventListener('change', save); // covers <select>
});

document.querySelectorAll('.toggle[data-setting]').forEach((el) => {
  el.addEventListener('click', () => {
    const key = el.dataset.setting;
    const next = el.getAttribute('aria-pressed') !== 'true';
    el.setAttribute('aria-pressed', next ? 'true' : 'false');
    saveSettings({ [key]: next });
    if (key === 'offline_mode') updateAccountForm();
  });
});

// ===== Inventory buttons =====
$('drop-btn').onclick = () => wsSend({ type: 'dropAll', accountId: currentTarget() });
$('equip-btn').onclick = () => wsSend({ type: 'equipArmor', accountId: currentTarget() });
$('use-btn').onclick = () => wsSend({ type: 'useItem', accountId: currentTarget() });

// ===== Leaderboard =====
$('lb-refresh').onclick = () => wsSend({ type: 'refreshLeaderboard' });

// Populate a "which account does this job" dropdown from the accounts list.
function fillAccountSelect(sel, value) {
  if (!sel) return;
  sel.innerHTML = '<option value="">Auto (first online)</option>';
  for (const acc of accounts) {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = acc.label || acc.username;
    sel.appendChild(opt);
  }
  sel.value = value || '';
}

function renderLeaderboardAccountOptions() {
  fillAccountSelect($('set-leaderboard_account'), settings.leaderboard_account);
  fillAccountSelect($('set-wall_account'), settings.wall_account);
}

function formatAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function renderLeaderboard() {
  const list = $('leaderboard-list');
  list.innerHTML = '';
  if (!leaderboard.entries.length) {
    const empty = document.createElement('div');
    empty.className = 'leaderboard-empty';
    empty.textContent = settings.leaderboard_enabled
      ? 'No data yet — connect a bot and Refresh.'
      : 'Off — enable it in Settings.';
    list.appendChild(empty);
  } else {
    for (const e of leaderboard.entries) {
      const row = document.createElement('div');
      row.className = 'leaderboard-row';

      const rank = document.createElement('span');
      rank.className = 'leaderboard-rank';
      rank.textContent = `${e.rank}.`;

      const name = document.createElement('span');
      name.className = 'leaderboard-name';
      name.textContent = e.name;

      const points = document.createElement('span');
      points.className = 'leaderboard-points';
      points.textContent = Number(e.points).toLocaleString();

      row.append(rank, name, points);
      if (e.gain != null && e.gain !== 0) {
        const gain = document.createElement('span');
        gain.className = 'leaderboard-gain';
        gain.textContent = `${e.gain > 0 ? '+' : ''}${Number(e.gain).toLocaleString()}`;
        row.append(gain);
      }
      list.appendChild(row);
    }
  }
  $('leaderboard-updated').textContent = leaderboard.updatedAt ? `updated ${formatAgo(leaderboard.updatedAt)}` : '';
}

// Keep the "updated Xm ago" text fresh without a re-fetch.
setInterval(() => {
  if (leaderboard.updatedAt) $('leaderboard-updated').textContent = `updated ${formatAgo(leaderboard.updatedAt)}`;
  renderWallSummary();
}, 60 * 1000);

// ===== Wall bot =====
$('wall-start').onclick = () => wsSend({ type: 'wallStart' });
$('wall-end').onclick = () => wsSend({ type: 'wallEnd' });
$('wall-check').onclick = () => wsSend({ type: 'wallCheck', player: 'panel' });
$('raid-start').onclick = () => wsSend({ type: 'raidStart' });
$('raid-stop').onclick = () => wsSend({ type: 'raidStop' });

// The browser sandbox won't let us fetch-and-save, so hand the URL to the browser directly.
$('wall-export').onclick = () => { location.href = '/api/wall/export'; };

// Reset is destructive, so it takes two clicks. No window.confirm — a native modal blocks the
// whole page, which is the last thing you want when driving the panel remotely.
$('wall-reset').onclick = () => $('wall-reset-confirm').classList.remove('hidden');
$('wall-reset-no').onclick = () => $('wall-reset-confirm').classList.add('hidden');
$('wall-reset-yes').onclick = async () => {
  $('wall-reset-confirm').classList.add('hidden');
  const note = $('wall-reset-result');
  try {
    const out = await api('/api/wall/reset', { method: 'POST' });
    note.innerHTML = '';
    note.append(document.createTextNode(`Reset. Backup of ${out.totalChecks} checks: `));
    const a = document.createElement('a');
    a.href = `/api/wall/backups/${encodeURIComponent(out.backup)}`;
    a.textContent = out.backup;
    note.appendChild(a);
  } catch (e) {
    note.textContent = e.message;
  }
};

function renderWallSummary() {
  const parts = [`${wall.totalChecks} check${wall.totalChecks === 1 ? '' : 's'} total`];
  parts.push(wall.lastCheckAt ? `last ${formatAgo(wall.lastCheckAt)}` : 'no checks yet');
  if (!wall.accountOnline) parts.push('no account online');
  $('wall-summary').textContent = parts.join(' · ');
}

function renderWallBot() {
  const state = $('wall-state');
  state.textContent = wall.raidActive ? 'RAID' : (wall.active ? 'running' : 'off');
  state.className = 'wall-state' + (wall.raidActive ? ' raid' : (wall.active ? ' on' : ''));

  renderWallSummary();

  const list = $('wall-list');
  list.innerHTML = '';
  if (!wall.top.length) {
    const empty = document.createElement('div');
    empty.className = 'leaderboard-empty';
    empty.textContent = 'No checks recorded yet.';
    list.appendChild(empty);
  } else {
    wall.top.forEach((entry, i) => {
      const row = document.createElement('div');
      row.className = 'leaderboard-row';

      const rank = document.createElement('span');
      rank.className = 'leaderboard-rank';
      rank.textContent = `${i + 1}.`;

      const name = document.createElement('span');
      name.className = 'leaderboard-name';
      name.textContent = entry.player;

      const checks = document.createElement('span');
      checks.className = 'leaderboard-points';
      checks.textContent = entry.checks;

      row.append(rank, name, checks);
      list.appendChild(row);
    });
  }

  renderRoster();
}

function renderRoster() {
  $('roster-count').textContent = `${wall.roster.length}`;
  const list = $('roster-list');
  list.innerHTML = '';
  if (!wall.roster.length) {
    const empty = document.createElement('div');
    empty.className = 'leaderboard-empty';
    empty.textContent = 'Nobody authorized yet.';
    list.appendChild(empty);
    return;
  }
  for (const entry of wall.roster) {
    const row = document.createElement('div');
    row.className = 'leaderboard-row';

    const name = document.createElement('span');
    name.className = 'leaderboard-name';
    name.textContent = entry.player;

    const badge = document.createElement('span');
    badge.className = 'roster-badge' + (entry.verified ? ' ok' : '');
    badge.textContent = entry.verified ? 'verified' : 'pending';

    const del = document.createElement('button');
    del.className = 'link-btn danger';
    del.textContent = '✕';
    del.title = `Remove ${entry.player}`;
    del.onclick = () => removeRosterPlayer(entry.player);

    row.append(name, badge, del);
    list.appendChild(row);
  }
}

$('roster-add').onclick = addRosterPlayer;
$('roster-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addRosterPlayer(); });

async function addRosterPlayer() {
  const input = $('roster-input');
  const player = input.value.trim();
  if (!player) return;
  try {
    wall.roster = await api('/api/wall/players', { method: 'POST', body: JSON.stringify({ player }) });
    input.value = '';
    renderRoster();
  } catch (e) {
    appendConsole({ text: e.message, error: true });
  }
}

async function removeRosterPlayer(player) {
  try {
    wall.roster = await api(`/api/wall/players/${encodeURIComponent(player)}`, { method: 'DELETE' });
    renderRoster();
  } catch (e) {
    appendConsole({ text: e.message, error: true });
  }
}

// ===== Console =====
function currentTarget() { return selectedAccountId; }

function renderConsoleTargets() {
  const sel = $('console-target');
  sel.innerHTML = '<option value="all">All accounts</option>';
  for (const acc of accounts) {
    const opt = document.createElement('option');
    opt.value = acc.id;
    opt.textContent = acc.label || acc.username;
    sel.appendChild(opt);
  }
  // Keep the dropdown in sync with the shared selection (fall back to 'all').
  if (![...sel.options].some((o) => o.value === selectedAccountId)) selectedAccountId = 'all';
  sel.value = selectedAccountId;
}

$('console-target').addEventListener('change', () => setTarget($('console-target').value));

function lineMatchesTarget(el) {
  const target = currentTarget();
  // Lines with no accountId (errors / system messages) always show.
  return target === 'all' || !el.dataset.accountId || el.dataset.accountId === target;
}

function applyConsoleFilter() {
  for (const el of $('console-output').children) {
    el.classList.toggle('hidden', !lineMatchesTarget(el));
  }
}

function appendConsole({ accountId, username, text, error }) {
  const out = $('console-output');
  const line = document.createElement('div');
  line.className = 'console-line' + (error ? ' err' : '');
  if (accountId) line.dataset.accountId = accountId;
  if (username) {
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = `[${username}] `;
    line.appendChild(who);
  }
  line.appendChild(document.createTextNode(text));
  if (!lineMatchesTarget(line)) line.classList.add('hidden');
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
  // Trim to last 500 lines.
  while (out.childElementCount > 500) out.removeChild(out.firstChild);
}

function sendChat() {
  const input = $('chat-input');
  const message = input.value;
  if (!message.trim()) return;
  wsSend({ type: 'sendChat', accountId: currentTarget(), message });
  input.value = '';
}
$('send-btn').onclick = sendChat;
$('chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
$('clear-console').onclick = () => { $('console-output').innerHTML = ''; };

// ===== MSA modal =====
function showMsaModal(code) {
  $('acc-hint').textContent = '';
  $('msa-code').textContent = code.user_code || '------';
  const link = code.verification_uri || 'https://microsoft.com/link';
  const a = $('msa-link');
  a.href = link; a.textContent = link;
  $('msa-modal').classList.remove('hidden');
}
function hideMsaModal() { $('msa-modal').classList.add('hidden'); }
$('msa-close').onclick = hideMsaModal;
