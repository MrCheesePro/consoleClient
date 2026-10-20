// Layout behaviour that app.js doesn't own: the numbered section index, and the plain-language
// view headers. Everything here reads DOM text app.js already writes (the hidden tile and rail
// elements) — it never touches settings, the socket, or app.js state. Uses its own attributes:
// `.tab`, `data-view` and `data-kind` belong to app.js.

const $ = (id) => document.getElementById(id);
const text = (id) => ($(id)?.textContent || '').trim();

// ---- section index ----

for (const index of document.querySelectorAll('[data-sections]')) {
  const group = index.dataset.sections;
  const buttons = [...index.querySelectorAll('[data-section]')];
  const panels = [...index.parentElement.querySelectorAll('[data-section-panel]')];
  const storeKey = `section:${group}`;

  const select = (name) => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.section === name));
    for (const p of panels) p.hidden = p.dataset.sectionPanel !== name;
    try { localStorage.setItem(storeKey, name); } catch { /* storage blocked — not needed */ }
  };

  let saved = null;
  try { saved = localStorage.getItem(storeKey); } catch { /* storage blocked */ }
  select(buttons.some((b) => b.dataset.section === saved) ? saved : buttons[0].dataset.section);

  index.addEventListener('click', (e) => {
    const b = e.target.closest('[data-section]');
    if (b) select(b.dataset.section);
  });
}

// ---- header sentences and the lantern ----

/**
 * The Raid Outpost state, read from the Engine caption. renderTiles in public/app.js builds that
 * caption as "<engine text> · outpost <label>", where <label> comes from RAID_OUTPOST_LABELS
 * ("claimed (grace)", "on cooldown", "LIVE"). No suffix means the outpost is idle. If that caption
 * format changes, this is the one place to update.
 */
function readOutpostState(captionText) {
  const m = / · outpost (.+)$/.exec(captionText || '');
  if (!m) return { key: 'idle', label: 'idle' };
  const label = m[1].trim();
  if (/live/i.test(label)) return { key: 'live', label: 'live' };
  if (/cooldown/i.test(label)) return { key: 'cooldown', label: 'on its 1-hour cooldown' };
  if (/claimed/i.test(label)) return { key: 'claimed', label: 'claimed, in its grace period' };
  return { key: 'idle', label };
}

const b = (value) => {
  const el = document.createElement('b');
  el.textContent = value;
  return el;
};

// Build a sentence from strings and <b> nodes without touching innerHTML — names in here come
// from the game server.
function setSentence(name, parts) {
  const el = document.querySelector(`[data-sentence="${name}"]`);
  if (!el) return;
  el.replaceChildren(...parts.map((p) => (typeof p === 'string' ? document.createTextNode(p) : p)));
}

const plural = (n, one, many) => `${n === '1' ? one : many}`;

function render() {
  // Accounts
  const total = text('tile-total');
  const online = text('tile-online');
  const standby = text('tile-standby');
  const faction = text('tile-faction');
  setSentence('bots', [
    b(total), ` ${plural(total, 'account', 'accounts')}, `, b(online), ' online and ', b(standby),
    ' on standby.',
    ...(faction && faction !== '—' ? [' Top faction: ', b(faction), '.'] : []),
  ]);

  // Wall Bot
  const outpost = readOutpostState(text('wtile-state-f'));
  const last = text('wtile-last');
  const checks = text('wtile-total');
  const roster = text('wtile-roster');
  setSentence('wall', [
    ...(last && last !== '—' ? ['Walls were last checked ', b(last), '. '] : ['No walls checked yet. ']),
    b(checks), ` ${plural(checks, 'check', 'checks')} all time, `, b(roster),
    ` verified ${plural(roster, 'player', 'players')}. Raid Outpost is `, b(outpost.label), '.',
  ]);

  const engine = text('wtile-state').toLowerCase();
  const state = engine === 'weewoo' ? 'weewoo' : engine === 'running' ? 'running' : 'off';
  const lantern = document.querySelector('.lantern');
  if (lantern) {
    lantern.dataset.state = state;
    lantern.querySelector('[data-lantern="state"]').textContent =
      state === 'weewoo' ? 'Weewoo sounding' : state === 'running' ? 'Keeping watch' : 'Resting';
    const [up = '0', all = '0'] = text('rail-online').split('/');
    const link = text('rail-conn');
    lantern.querySelector('[data-lantern="line"]').textContent =
      `${up} of ${all} bots online · panel link ${link || '—'}`;
  }

  for (const chip of document.querySelectorAll('[data-outpost-chips] [data-chip]')) {
    const on = chip.dataset.chip === outpost.key;
    chip.classList.toggle('on', on);
    if (on) chip.setAttribute('aria-current', 'step'); else chip.removeAttribute('aria-current');
  }

  // Console
  const [up = '0', all = '0'] = text('rail-online').split('/');
  const target = $('console-target');
  const showing = target?.selectedOptions[0]?.textContent || 'All accounts';
  setSentence('console', [b(up), ' of ', b(all), ' bots online. Showing ', b(showing), '.']);
}

// app.js rewrites these on every state change; mirror them whenever they move.
const watched = ['tile-total', 'tile-online', 'tile-standby', 'tile-faction', 'wtile-state',
  'wtile-state-f', 'wtile-last', 'wtile-total', 'wtile-roster', 'rail-online', 'rail-conn',
  'console-target'];
let queued = false;
const schedule = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
};
const observer = new MutationObserver(schedule);
for (const id of watched) {
  const el = $(id);
  if (el) observer.observe(el, { childList: true, characterData: true, subtree: true });
}
$('console-target')?.addEventListener('change', schedule);
render();
