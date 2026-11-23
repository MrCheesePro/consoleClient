// Reports. A player whispers `report` to the wall bot, which whispers back a one-time link; the
// form behind it saves a ticket (with the sender) to the panel and posts it to the report Discord
// webhook WITHOUT the sender. Discord readers see an anonymous ticket; only the panel sees who.
// The route is public (no panel password): Caddy should expose only /r/* on the report hostname.
import crypto from 'node:crypto';
import express from 'express';
import { getSettings, insertReport, listWallPlayers } from './db/db.js';

export const REPORT_TTL_MS = 30 * 60 * 1000;
export const REPORT_MAX_LEN = 2000;
// Lowercase letters and digits only: chat plugins (anti-caps, anti-advertising) and people typing
// the link by hand mangle case and punctuation, and a mangled token reads as an expired link.
const TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_LEN = 16; // ~82 bits
const TOKEN_RE = /^[a-z0-9]{16}$/;

// ponytail: in-memory, so a restart kills outstanding links; persist if that ever matters.
const tokens = new Map(); // token -> { userId, player, expiresAt }

export function issueReportToken(userId, player, now = Date.now()) {
  for (const [t, v] of tokens) if (v.expiresAt <= now) tokens.delete(t);
  // 16 chars: plenty for a 30-minute single-use link, and short enough that
  // `/msg <16-char name> Report: <url>` stays under Minecraft's 100-character chat limit.
  let token = '';
  for (let i = 0; i < TOKEN_LEN; i++) token += TOKEN_ALPHABET[crypto.randomInt(TOKEN_ALPHABET.length)];
  tokens.set(token, { userId, player, expiresAt: now + REPORT_TTL_MS });
  return token;
}

// Every refusal logs its reason (to journald on the VPS), since the player only ever sees
// "expired or already used": malformed = the link was altered in chat; unknown = never issued
// by this process (restarted since, or another copy of the panel sent it) or already used.
function live(token, now = Date.now()) {
  let why = null;
  const entry = TOKEN_RE.test(token) ? tokens.get(token) : null;
  if (!TOKEN_RE.test(token)) why = 'malformed';
  else if (!entry) why = 'unknown or already used';
  else if (entry.expiresAt <= now) why = 'expired';
  if (why) { console.warn(`[report] link refused (${why}): /r/${String(token).slice(0, 40)}`); return null; }
  return entry;
}

export function reportUrl(token) {
  const base = String(process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  return base ? `${base}/r/${token}` : '';
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;background:#17161a;color:#e8e4dc;margin:0;padding:24px 16px}
main{max-width:560px;margin:0 auto}h1{font-size:1.4rem;margin:0 0 8px}p{color:#a9a39a}
label{display:block;margin:16px 0 6px}fieldset{border:0;padding:0;margin:16px 0 0}
legend{padding:0;margin-bottom:6px}.choice{display:flex;gap:10px;align-items:flex-start;margin:6px 0;
padding:10px;border:1px solid #3a3740;border-radius:6px;cursor:pointer}.choice input{width:auto;margin:4px 0 0}
.choice small{display:block;color:#a9a39a}input,textarea,select{width:100%;box-sizing:border-box;padding:10px;
border-radius:6px;border:1px solid #3a3740;background:#211f25;color:inherit;font:inherit}
textarea{min-height:180px;resize:vertical}button{margin-top:16px;padding:10px 18px;border:0;
border-radius:6px;background:#c9a96e;color:#17161a;font:inherit;font-weight:600;cursor:pointer}
</style></head><body><main>${body}</main></body></html>`;
}

// Who a report can be about: the players the bot has verified, minus the reporter. The form offers
// only these, and the POST re-checks against the same list, so a hand-edited form can't name
// anyone else.
const verifiedPlayers = (entry) => listWallPlayers.all(entry.userId)
  .filter((p) => p.verified && p.player !== entry.player)
  .map((p) => p.player);

const formPage = (token, players) => page('Report', `
<h1>Report</h1>
<p>The Turtle Council will read the information. This link works once.</p>
<form method="post" action="/r/${esc(token)}">
<fieldset>
<legend>What are you sending?</legend>
<label class="choice"><input type="radio" name="kind" value="report" checked>
<span>🚩 A report<small>Something someone did wrong.</small></span></label>
<label class="choice"><input type="radio" name="kind" value="praise">
<span>🌟 A good message<small>A shout-out for someone who did well.</small></span></label>
</fieldset>
<label for="about">Who is this about? (optional)</label>
<select id="about" name="about">
<option value="">Nobody in particular</option>
${players.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('')}
</select>
<label for="text">What happened?</label>
<textarea id="text" name="text" required maxlength="${REPORT_MAX_LEN}"></textarea>
<fieldset>
<legend>Show your name?</legend>
<label class="choice"><input type="radio" name="identity" value="anonymous" checked>
<span>Stay anonymous<small>Your name is left off the post the council sees.</small></span></label>
<label class="choice"><input type="radio" name="identity" value="named">
<span>Show my name<small>The council sees that this came from you.</small></span></label>
<p><small>Either way, whoever runs the bot can see who sent each message.</small></p>
</fieldset>
<button type="submit">Send</button>
</form>`);

const deadPage = () => page('Link expired', '<h1>This link has expired or was already used.</h1><p>Message the bot <b>report</b> again for a new one.</p>');

export function createReportRouter({ post = postToDiscord, emitToUser = () => {} } = {}) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));
  router.use((req, res, next) => { res.set('Referrer-Policy', 'no-referrer'); next(); });

  router.param('token', (req, _res, next, t) => { req.params.token = String(t).toLowerCase(); next(); });

  router.get('/:token', (req, res) => {
    const entry = live(req.params.token);
    if (!entry) return res.status(410).send(deadPage());
    res.send(formPage(req.params.token, verifiedPlayers(entry)));
  });

  router.post('/:token', async (req, res) => {
    const { token } = req.params;
    const entry = live(token);
    if (!entry) return res.status(410).send(deadPage());
    const text = String(req.body?.text || '').trim().slice(0, REPORT_MAX_LEN);
    const picked = String(req.body?.about || '').trim().toLowerCase();
    const about = verifiedPlayers(entry).includes(picked) ? picked : '';
    // Anything but an explicit "named" stays anonymous: the safe default if the field is missing.
    const anonymous = req.body?.identity === 'named' ? 0 : 1;
    const kind = req.body?.kind === 'praise' ? 'praise' : 'report';
    if (!text) return res.status(400).send(formPage(token, verifiedPlayers(entry)));

    const settings = getSettings.get(entry.userId);
    const webhook = settings?.report_discord_webhook;
    // Fails shut: unlike the other channels, never fall back to the wall webhook — a complaint
    // landing in the faction-wide channel is worse than it not sending. The panel's off switch
    // also closes links that were already handed out.
    if (!webhook || !settings.reports_enabled) return res.status(503).send(page('Unavailable', '<h1>Reports are turned off right now.</h1>'));

    // Consume first so a double-submit can't file twice. The ticket is saved before Discord is
    // tried, so a dead webhook never loses a report — it is still in the panel.
    tokens.delete(token);
    const report = { user_id: entry.userId, player: entry.player, about, text, anonymous, kind, created_at: Date.now() };
    const id = Number(insertReport.run(report).lastInsertRowid);
    const { user_id: _u, ...row } = report;
    emitToUser(entry.userId, { type: 'reportFiled', report: { id, ...row } });
    let note = '';
    try {
      // The sender reaches Discord only when the reporter chose to be named.
      await post(webhook, { id, kind, text, about, ...(anonymous ? {} : { player: entry.player }) });
    } catch {
      note = '<p>Discord did not take it, but it is saved and staff will see it.</p>';
    }
    res.send(page('Sent', `<h1>${kind === 'praise' ? 'Shout-out' : 'Report'} #${id} sent.</h1>${note}<p>You can close this page.</p>`));
  });

  return router;
}

const HEAD_URL = (name) => `https://mc-heads.net/avatar/${encodeURIComponent(name)}/64`;
const MC_NAME_RE = /^\w{3,16}$/;

export const REPORT_KINDS = {
  report: { color: 0x8B5A2B, title: '🚩 Report', target: 'Reported player', footer: 'Turtle Council · Reports' },
  praise: { color: 0x2ECC71, title: '🌟 Shout-out', target: 'Shout-out for', footer: 'Turtle Council · Shout-outs' },
};

// Shared shape with the panel preview (public/embed-preview.js mirrors it). `player` is set only
// when the reporter chose to be named; otherwise nothing in the embed identifies them.
export function reportEmbed({ id, kind = 'report', text, about, player }) {
  const k = REPORT_KINDS[kind] || REPORT_KINDS.report;
  // Quote every line so the message reads as the player's own words.
  const quoted = text.split(/\r?\n/).map((l) => `> ${l}`).join('\n').slice(0, 3900);
  const word = kind === 'praise' ? 'Shout-out' : 'Report';
  // Number on top as the title, who sent it on the line under. Discord always draws `author` above
  // the title, so the "from" line lives at the top of the description instead.
  const from = player ? `${word} from **${player}**` : `Anonymous ${word.toLowerCase()}`;
  const embed = {
    color: k.color,
    title: `${k.title} #${id}`,
    description: `${from}\n\n${quoted}`,
    fields: [
      { name: k.target, value: about || '*not given*', inline: true },
      { name: 'Submitted by', value: player || '🕶️ Anonymous', inline: true },
    ],
    footer: { text: k.footer },
    timestamp: new Date().toISOString(),
  };
  if (MC_NAME_RE.test(about)) embed.thumbnail = { url: HEAD_URL(about) };
  return embed;
}

async function postToDiscord(webhook, report) {
  const embed = reportEmbed(report);
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // allowed_mentions empty: a report can never ping anyone, whatever it contains.
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
