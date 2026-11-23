// Reports. A player whispers `report` to the wall bot, which whispers back a one-time link; the
// form behind it saves a ticket (with the sender) to the panel and posts it to the report Discord
// webhook WITHOUT the sender. Discord readers see an anonymous ticket; only the panel sees who.
// The route is public (no panel password): Caddy should expose only /r/* on the report hostname.
import crypto from 'node:crypto';
import express from 'express';
import { getSettings, insertReport } from './db/db.js';

export const REPORT_TTL_MS = 30 * 60 * 1000;
export const REPORT_MAX_LEN = 2000;
const TOKEN_RE = /^[A-Za-z0-9_-]{16}$/;

// ponytail: in-memory, so a restart kills outstanding links; persist if that ever matters.
const tokens = new Map(); // token -> { userId, player, expiresAt }

export function issueReportToken(userId, player, now = Date.now()) {
  for (const [t, v] of tokens) if (v.expiresAt <= now) tokens.delete(t);
  // 12 bytes (96 bits, 16 chars): plenty for a 30-minute single-use link, and short enough that
  // `/msg <16-char name> Report: <url>` stays under Minecraft's 100-character chat limit.
  const token = crypto.randomBytes(12).toString('base64url');
  tokens.set(token, { userId, player, expiresAt: now + REPORT_TTL_MS });
  return token;
}

function live(token, now = Date.now()) {
  if (!TOKEN_RE.test(token)) return null;
  const entry = tokens.get(token);
  if (!entry || entry.expiresAt <= now) return null;
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
label{display:block;margin:16px 0 6px}input,textarea{width:100%;box-sizing:border-box;padding:10px;
border-radius:6px;border:1px solid #3a3740;background:#211f25;color:inherit;font:inherit}
textarea{min-height:180px;resize:vertical}button{margin-top:16px;padding:10px 18px;border:0;
border-radius:6px;background:#c9a96e;color:#17161a;font:inherit;font-weight:600;cursor:pointer}
</style></head><body><main>${body}</main></body></html>`;
}

const formPage = (token) => page('Report', `
<h1>Report</h1>
<p>The Turtle Council will read the information. This link works once.</p>
<form method="post" action="/r/${esc(token)}">
<label for="about">Who is this about? (optional)</label>
<input id="about" name="about" maxlength="64" autocomplete="off">
<label for="text">What happened?</label>
<textarea id="text" name="text" required maxlength="${REPORT_MAX_LEN}"></textarea>
<button type="submit">Send report</button>
</form>`);

const deadPage = () => page('Link expired', '<h1>This link has expired or was already used.</h1><p>Message the bot <b>report</b> again for a new one.</p>');

export function createReportRouter({ post = postToDiscord, emitToUser = () => {} } = {}) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '16kb' }));
  router.use((req, res, next) => { res.set('Referrer-Policy', 'no-referrer'); next(); });

  router.get('/:token', (req, res) => {
    if (!live(req.params.token)) return res.status(410).send(deadPage());
    res.send(formPage(req.params.token));
  });

  router.post('/:token', async (req, res) => {
    const { token } = req.params;
    const entry = live(token);
    if (!entry) return res.status(410).send(deadPage());
    const text = String(req.body?.text || '').trim().slice(0, REPORT_MAX_LEN);
    const about = String(req.body?.about || '').trim().slice(0, 64);
    if (!text) return res.status(400).send(formPage(token));

    const settings = getSettings.get(entry.userId);
    const webhook = settings?.report_discord_webhook;
    // Fails shut: unlike the other channels, never fall back to the wall webhook — a complaint
    // landing in the faction-wide channel is worse than it not sending. The panel's off switch
    // also closes links that were already handed out.
    if (!webhook || !settings.reports_enabled) return res.status(503).send(page('Unavailable', '<h1>Reports are turned off right now.</h1>'));

    // Consume first so a double-submit can't file twice. The ticket is saved before Discord is
    // tried, so a dead webhook never loses a report — it is still in the panel.
    tokens.delete(token);
    const report = { user_id: entry.userId, player: entry.player, about, text, created_at: Date.now() };
    const id = Number(insertReport.run(report).lastInsertRowid);
    const { user_id: _u, ...row } = report;
    emitToUser(entry.userId, { type: 'reportFiled', report: { id, ...row } });
    let note = '';
    try {
      await post(webhook, { id, text, about });
    } catch {
      note = '<p>Discord did not take it, but it is saved and staff will see it.</p>';
    }
    res.send(page('Sent', `<h1>Report #${id} sent.</h1>${note}<p>You can close this page.</p>`));
  });

  return router;
}

async function postToDiscord(webhook, { id, text, about }) {
  const embed = { color: 0xE67E22, title: `Report #${id}`, description: text, timestamp: new Date().toISOString() };
  if (about) embed.fields = [{ name: 'About', value: about }];
  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // allowed_mentions empty: a report can never ping anyone, whatever it contains.
    body: JSON.stringify({ embeds: [embed], allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}
