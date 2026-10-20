// Discord embed preview for the Wall Bot → Discord section. Renders, with sample values, what
// the bot's webhook posts look like, using the templates currently in the form, and which channel
// each would land in. Display only: it reads the settings inputs and never saves anything.
//
// The shapes mirror the embeds built in server/bots/WallBot.js (_tick, _countCheck,
// _sendRaidAlert, _raidOutpostNotice) and the routing in WallBot#_send. If those change, update
// this to match — the preview is a picture of them, not a second source of truth.

const COLORS = { alert: '#ED4245', ok: '#57F287', log: '#22D3EE', raidLog: '#9B59B6', muted: '#99AAB5' };
const DISCORD_REMINDER_DEFAULT = 'Minutes Unchecked: **{minutes}**\nLast Checker: **{player}** (Total Checks: {checks})';
const DISCORD_RAID_OUTPOST_DEFAULT = 'Raid Minutes Unchecked: **{raidMinutes}**\nLast Checker: **{raidPlayer}** (Total Raid Checks: {raidChecks})';
const DISCORD_RAID_DEFAULT = 'Check walls immediately and get online.';
// In-game chat defaults (server/db/db.js), shown under each reminder as the line sent to Minecraft.
const REMINDER_DEFAULT = 'Check Walls /msg captunnel WALLS : Minutes since last checked: {minutes} by {player}';
const RAID_OUTPOST_REMINDER_DEFAULT = 'Check Raid Outpost /msg {bot} raid : Minutes since last checked: {raidMinutes}m [{raidPlayer}]';
const RAID_OUTPOST_COMBINED_DEFAULT = 'Check Raid Outpost | Walls /msg {bot} walls / raid : Minutes since last checked: '
  + 'Raid: {raidMinutes}m [{raidPlayer}] | Walls: {minutes}m [{player}]';
const SAMPLE = { minutes: 12, player: 'zghostx', checks: 127, total: 342, raidMinutes: 5, raidPlayer: 'acesoft', raidChecks: 9, bot: 'WallBot' };

const value = (key) => document.querySelector(`[data-setting="${key}"]`)?.value?.trim() || '';
const on = (key) => document.querySelector(`.toggle[data-setting="${key}"]`)?.getAttribute('aria-pressed') === 'true';

function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, k) => (k in values ? String(values[k]) : whole));
}

// The small subset of Discord markdown the bot's messages use: **bold**, `code`, line breaks.
// Text is set through textContent first, so nothing from a template is ever parsed as HTML.
function markdown(text) {
  const frag = document.createDocumentFragment();
  String(text).split('\n').forEach((line, i) => {
    if (i) frag.appendChild(document.createElement('br'));
    for (const part of line.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
      if (!part) continue;
      let el;
      if (part.startsWith('**') && part.endsWith('**')) { el = document.createElement('strong'); el.textContent = part.slice(2, -2); }
      else if (part.startsWith('`') && part.endsWith('`')) { el = document.createElement('code'); el.textContent = part.slice(1, -1); }
      else el = document.createTextNode(part);
      frag.appendChild(el);
    }
  });
  return frag;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// Where WallBot#_send would post this channel: its own webhook when toggled on with a URL, else
// the wall webhook when "Send to Discord" is on, else nowhere.
function destination(channel) {
  const own = {
    check: on('check_to_discord') && value('check_discord_webhook') ? 'logs webhook' : null,
    raid: on('raid_to_discord') && value('raid_discord_webhook') ? 'weewoo webhook' : null,
    raid_outpost: value('raid_outpost_discord_webhook') ? 'Raid Outpost webhook' : null,
  }[channel];
  if (own) return { text: `→ ${own}`, sent: true };
  if (on('wall_to_discord') && value('wall_discord_webhook')) return { text: '→ wall webhook', sent: true };
  return { text: 'not sent: no webhook is on for this', sent: false };
}

// The role mention WallBot puts in a post's content, mirroring parseRoleId.
function pingLine(toggleKey) {
  if (!on(toggleKey)) return null;
  const m = /^\s*(?:<@&)?(\d{5,25})>?\s*$/.exec(value('discord_ping_role'));
  return m ? '@Role' : null;
}

function embed({ name, when, channel, color, author, title, description, fields, footer, chat, ping }) {
  const wrap = el('figure', 'dp-item');
  const where = destination(channel);
  const cap = el('figcaption', 'dp-caption');
  cap.append(el('span', 'dp-name', name), el('span', `dp-where${where.sent ? '' : ' off'}`, where.text));
  wrap.appendChild(cap);
  if (when) wrap.appendChild(el('p', 'dp-when', when));

  if (ping) wrap.appendChild(el('div', 'dp-ping', ping));
  const card = el('div', 'dp-embed');
  card.style.borderLeftColor = color;
  if (author) {
    const a = el('div', 'dp-author');
    a.append(el('span', 'dp-avatar'), el('span', '', author));
    card.appendChild(a);
  }
  if (title) card.appendChild(el('div', 'dp-title', title));
  if (description) { const d = el('div', 'dp-desc'); d.appendChild(markdown(description)); card.appendChild(d); }
  if (fields?.length) {
    const g = el('div', 'dp-fields');
    for (const f of fields) {
      const cell = el('div', `dp-field${f.inline ? '' : ' wide'}`);
      const v = el('div', 'dp-field-v'); v.appendChild(markdown(f.value));
      cell.append(el('div', 'dp-field-k', f.name), v);
      g.appendChild(cell);
    }
    card.appendChild(g);
  }
  card.appendChild(el('div', 'dp-footer', `${footer ? `${footer} • ` : ''}Today at 10:00 AM`));
  wrap.appendChild(card);
  if (chat) {
    // One chat message per line, the way WallBot#_send splits it.
    const game = el('div', 'dp-chat');
    game.appendChild(el('span', 'dp-chat-k', 'In game'));
    for (const line of chat.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) game.appendChild(el('div', 'dp-chat-line', line));
    wrap.appendChild(game);
  }
  return wrap;
}

function render() {
  const root = document.getElementById('discord-preview');
  if (!root) return;
  const bot = SAMPLE.bot;
  const faction = value('raid_outpost_faction') || 'TurtleGang';
  const wallBody = fill(value('wall_discord_message') || DISCORD_REMINDER_DEFAULT, SAMPLE);
  const raidBody = fill(DISCORD_RAID_OUTPOST_DEFAULT, SAMPLE);
  const grace = on('grace_period');
  root.replaceChildren(
    // The three reminder shapes from WallBot#_tick. Only one goes out per reminder.
    embed({
      name: 'Walls + Raid Outpost, bundled', channel: 'wall', color: COLORS.alert,
      when: 'While the Raid Outpost is live (outside grace period and quiet hours): one post covering both.',
      title: 'Raid Outpost | Walls Alert!', description: `${raidBody}\n\n${wallBody}`,
      chat: fill(value('raid_outpost_combined_message') || RAID_OUTPOST_COMBINED_DEFAULT, SAMPLE),
    }),
    embed({
      name: 'Wall reminder', channel: 'wall', color: COLORS.alert,
      when: "When the Raid Outpost isn't live.",
      title: 'Wall Check Alert!', description: wallBody,
      chat: fill(value('wall_reminder_message') || REMINDER_DEFAULT, SAMPLE),
    }),
    embed({
      name: 'Raid Outpost only', channel: 'wall', color: COLORS.alert,
      when: 'While the outpost is live during grace period or quiet hours: walls stay silent.',
      title: grace ? 'Raid Outpost Alert (Grace Period)!' : 'Raid Outpost Alert!', description: raidBody,
      chat: fill(value('raid_outpost_reminder_message') || RAID_OUTPOST_REMINDER_DEFAULT, SAMPLE),
    }),
    // Check logs, from WallBot#_countCheck. One per check; "walls raid" sends both.
    ...[['wall', 'WALL CHECK', SAMPLE.player, '12m 4s'], ['raid', 'RAID OUTPOST CHECK', SAMPLE.raidPlayer, '5m 12s']].map(([kind, label, who, since]) => embed({
      name: kind === 'raid' ? 'Check log: Raid Outpost check' : 'Check log: wall check',
      channel: 'check', color: kind === 'raid' ? COLORS.raidLog : COLORS.log, author: `${who} recorded a ${label}.`,
      fields: [
        { name: 'Clear at', value: '`2026/10/20 10:00:00`', inline: false },
        { name: 'Time since last check', value: `\`${since}\``, inline: true },
        { name: 'Raid Checks', value: `\`${SAMPLE.raidChecks}\``, inline: true },
        { name: 'Wall Checks', value: `\`${SAMPLE.checks}\``, inline: true },
      ],
      footer: bot,
    })),
    embed({
      name: 'Weewoo alert', channel: 'raid', color: COLORS.alert, author: 'WE ARE GETTING RAIDED!',
      ping: pingLine('ping_weewoo'),
      description: `**${value('raid_discord_message') || DISCORD_RAID_DEFAULT}**`,
      fields: [
        { name: 'Alert started', value: '`2026/10/20 10:00:00`', inline: false },
        { name: 'Time since alert', value: '`45s`', inline: true },
      ],
      footer: bot,
    }),
    embed({
      name: 'Raid Outpost claimed', channel: 'raid_outpost', color: COLORS.ok,
      ping: pingLine('ping_raid_outpost'),
      description: `**We claimed the Raid Outpost (${faction}).**`,
    }),
  );
}

// Re-render as the form changes. app.js fills the inputs and sets each toggle's aria-pressed when
// settings arrive, so watching the toggles also catches the first load.
let queued = false;
const schedule = () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; render(); });
};
document.addEventListener('input', schedule);
document.addEventListener('change', schedule);
const watcher = new MutationObserver(schedule);
for (const t of document.querySelectorAll('.toggle[data-setting]')) {
  watcher.observe(t, { attributes: true, attributeFilter: ['aria-pressed'] });
}
render();
