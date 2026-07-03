// ===== State =====
let settings = {};
let accounts = [];
const statuses = {};      // accountId -> 'online' | 'connecting' | 'offline'
let selectedAccountId = 'all';  // console/inventory target, shared with the Accounts list
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
  updateAccountForm();
  connectWs();
}

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

    const del = document.createElement('button');
    del.className = 'account-del';
    del.textContent = '×';
    del.title = 'Remove account';
    del.onclick = (e) => { e.stopPropagation(); deleteAccount(acc); };

    row.append(dot, name, tag, status, del);
    list.appendChild(row);
  }

  // Header: count + select-all state.
  $('account-count').textContent = `${accounts.length} account${accounts.length === 1 ? '' : 's'}`;
  const enabledCount = accounts.filter((a) => a.load_enabled).length;
  const cb = $('select-all');
  cb.checked = accounts.length > 0 && enabledCount === accounts.length;
  cb.indeterminate = enabledCount > 0 && enabledCount < accounts.length;

  renderConsoleTargets();
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

document.querySelectorAll('input[data-setting], textarea[data-setting]').forEach((el) => {
  el.addEventListener('input', () => {
    const key = el.dataset.setting;
    saveSettings({ [key]: el.value });
  });
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
