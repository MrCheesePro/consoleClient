import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  insertAccount, listAccounts, deleteAccount, setAccountLoad, setAllAccountsLoad,
  getAccountById, getSettings, updateSettings,
  getWallState, allWallCheckers, listWallPlayers, upsertWallPlayer, deleteWallPlayer, getWallPlayer, updateWallPlayerTax,
  resetWallStats, setDisplayName,
  listReports, listChatDays, chatForDay, searchChat,
} from './db/db.js';
import { authenticateMicrosoft } from './auth/mcAuth.js';
import { normalizePlayer, mojangName, parseMatchQuery, MINOR_RE, buildMatchProfile } from './bots/WallBot.js';

const BOOL_KEYS = new Set([
  'show_chat', 'auto_reconnect', 'sneak', 'anti_afk', 'offline_mode', 'spam_enabled',
  'leaderboard_enabled', 'leaderboard_to_discord',
  'wall_enabled', 'wall_require_verified', 'wall_to_minecraft', 'wall_to_discord',
  'raid_enabled', 'raid_to_discord', 'check_to_discord', 'grace_period',
  'ping_weewoo', 'ping_raid_outpost', 'reports_enabled', 'reports_verified_only',
  'match_nsfw',
]);
const INT_KEYS = new Set([
  'login_delay_ms', 'spam_delay_ms', 'wall_interval_ms', 'raid_delay_ms',
]);

// Floors that stop a typo from turning the bot into a chat flood (and getting the account muted).
const MIN_VALUES = { wall_interval_ms: 30000, raid_delay_ms: 3000 };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR = process.env.WALL_BACKUPS_DIR
  || path.join(__dirname, '..', 'data', 'wall-backups');
const BACKUP_NAME_RE = /^wall-stats-[\w.:-]+\.json$/;

function normalizeSettingsPatch(body) {
  const patch = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (BOOL_KEYS.has(k)) patch[k] = v ? 1 : 0;
    else if (INT_KEYS.has(k)) {
      const n = Math.max(0, parseInt(v, 10) || 0);
      patch[k] = n === 0 ? 0 : Math.max(MIN_VALUES[k] || 0, n);
    } else patch[k] = String(v ?? '');
  }
  return patch;
}

/** The full wall-bot snapshot, used for both the export download and the pre-reset backup. */
function buildWallExport(userId) {
  const state = getWallState.get(userId);
  return {
    exportedAt: new Date().toISOString(),
    totalChecks: state?.total_checks || 0,
    lastCheckAt: state?.last_check_at || 0,
    players: allWallCheckers.all(userId),
    roster: listWallPlayers.all(userId),
  };
}

// `token_ref` is the prismarine-auth cache key for a Microsoft account. The browser never
// needs it, so it doesn't leave the server.
function publicAccount(account) {
  if (!account) return account;
  const { token_ref, ...rest } = account;
  return rest;
}

export function createApiRouter({ botManager, emitToUser }) {
  const router = express.Router();

  // ---- Accounts ----
  // Any successful account change tells every open panel to re-fetch the list, so a second
  // viewer never acts on an account that was deleted or toggled elsewhere.
  router.use('/accounts', (req, res, next) => {
    if (req.method !== 'GET') {
      res.on('finish', () => {
        if (res.statusCode < 300) emitToUser(req.session.userId, { type: 'accountsChanged' });
      });
    }
    next();
  });

  router.get('/accounts', (req, res) => {
    res.json(listAccounts.all(req.session.userId).map(publicAccount));
  });

  router.post('/accounts', async (req, res) => {
    const userId = req.session.userId;
    const authType = req.body?.authType === 'microsoft' ? 'microsoft' : 'offline';

    if (authType === 'offline') {
      const username = String(req.body?.username || '').trim();
      if (!/^[A-Za-z0-9_]{1,16}$/.test(username)) {
        return res.status(400).json({ error: 'Username must be 1-16 chars (letters, digits, underscore).' });
      }
      const account = insertAccount(userId, { label: username, username, authType: 'offline' });
      return res.status(201).json(publicAccount(account));
    }

    // Microsoft: kick off device-code flow; respond immediately, finish over WS.
    const label = String(req.body?.label || 'Microsoft account').trim();
    const tokenRef = randomUUID();
    res.status(202).json({ pending: true });

    try {
      const { username } = await authenticateMicrosoft(userId, tokenRef, (code) => {
        emitToUser(userId, { type: 'msaCode', code });
      });
      const account = insertAccount(userId, { label: username || label, username, authType: 'microsoft', tokenRef });
      emitToUser(userId, { type: 'accountAdded', account: publicAccount(account) });
    } catch (e) {
      emitToUser(userId, { type: 'error', message: `Microsoft login failed: ${e.message}` });
    }
  });

  router.delete('/accounts/:id', (req, res) => {
    const userId = req.session.userId;
    const account = getAccountById.get(req.params.id, userId);
    if (!account) return res.status(404).json({ error: 'Not found' });
    botManager.disconnect(userId, [account.id]);
    deleteAccount.run(account.id, userId);
    res.json({ ok: true });
  });

  router.post('/accounts/load-all', (req, res) => {
    const userId = req.session.userId;
    setAllAccountsLoad.run(req.body?.enabled ? 1 : 0, userId);
    res.json(listAccounts.all(userId).map(publicAccount));
  });

  router.post('/accounts/:id/load', (req, res) => {
    const userId = req.session.userId;
    const account = getAccountById.get(req.params.id, userId);
    if (!account) return res.status(404).json({ error: 'Not found' });
    const enabled = req.body?.enabled ? 1 : 0;
    setAccountLoad.run(enabled, account.id, userId);
    res.json({ ...publicAccount(account), load_enabled: enabled });
  });

  // ---- Settings ----
  router.get('/settings', (req, res) => {
    res.json(getSettings.get(req.session.userId));
  });

  router.put('/settings', (req, res) => {
    const userId = req.session.userId;
    const updated = updateSettings(userId, normalizeSettingsPatch(req.body));
    botManager.applySettings(userId);
    // Every open panel (the saver included) gets the canonical row.
    emitToUser(userId, { type: 'settings', settings: updated });
    res.json(updated);
  });

  // ---- Wall bot: stats export / reset / roster ----
  // Reset and export are file- and CRUD-shaped, so they live on REST rather than the WS
  // control channel; live wall state still streams over WS as `wallState`.

  router.get('/wall/export', (req, res) => {
    const data = buildWallExport(req.session.userId);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="wall-stats-${Date.now()}.json"`);
    res.send(JSON.stringify(data, null, 2));
  });

  router.post('/wall/reset', (req, res) => {
    const userId = req.session.userId;
    const data = buildWallExport(userId);
    const name = `wall-stats-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

    // Back up BEFORE wiping. The JSON file is the only copy of the pre-reset numbers, so if the
    // write fails we abort and leave the database untouched.
    try {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
      fs.writeFileSync(path.join(BACKUPS_DIR, name), JSON.stringify(data, null, 2));
    } catch (e) {
      return res.status(500).json({ error: `Backup failed, nothing was reset: ${e.message}` });
    }

    resetWallStats(userId);
    botManager.wallReload(userId); // re-read the zeroed counters and repaint the panel
    res.json({ ok: true, backup: name, totalChecks: data.totalChecks });
  });

  router.get('/wall/backups', (req, res) => {
    let names = [];
    try { names = fs.readdirSync(BACKUPS_DIR); } catch { return res.json([]); }
    const files = names
      .filter((n) => BACKUP_NAME_RE.test(n))
      .map((n) => {
        const stat = fs.statSync(path.join(BACKUPS_DIR, n));
        return { name: n, size: stat.size, modified: stat.mtimeMs };
      })
      .sort((a, b) => b.modified - a.modified);
    res.json(files);
  });

  router.get('/wall/backups/:file', (req, res) => {
    const name = req.params.file;
    // Validate the shape, then confirm the resolved path really is inside the backups dir —
    // never hand user input straight to path.join and read whatever comes out.
    if (!BACKUP_NAME_RE.test(name)) return res.status(400).json({ error: 'Bad filename.' });
    const full = path.resolve(BACKUPS_DIR, name);
    if (path.dirname(full) !== path.resolve(BACKUPS_DIR)) {
      return res.status(400).json({ error: 'Bad filename.' });
    }
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found.' });
    res.download(full, name);
  });

  router.get('/wall/players', (req, res) => {
    res.json(listWallPlayers.all(req.session.userId));
  });

  router.post('/wall/players', (req, res) => {
    const userId = req.session.userId;
    const player = normalizePlayer(req.body?.player);
    if (!/^[a-z0-9_]{1,16}$/.test(player)) {
      return res.status(400).json({ error: 'Username must be 1-16 chars (letters, digits, underscore).' });
    }
    // Added from the panel means added by the operator — the admin_verify equivalent, so it
    // lands pre-verified and needs no in-game code.
    upsertWallPlayer.run({
      user_id: userId,
      player,
      verified: 1,
      label: String(req.body?.label || '').slice(0, 64),
      added_at: Date.now(),
    });
    botManager.wallBroadcast(userId);
    res.status(201).json(listWallPlayers.all(userId));
    // Real capitalization arrives a moment later; the broadcast refreshes the panel.
    mojangName(player).then((real) => {
      if (real && setDisplayName(real, userId, player)) botManager.wallBroadcast(userId);
    });
  });

  // Tax tags and Discord ID for one roster player. A pasted mention (<@123>) is accepted.
  router.patch('/wall/players/:player', (req, res) => {
    const userId = req.session.userId;
    const player = normalizePlayer(req.params.player);
    const row = getWallPlayer.get(userId, player);
    if (!row) return res.status(404).json({ error: 'Not on the roster.' });
    const b = req.body || {};
    let discordId = row.discord_id;
    if (b.discord_id !== undefined) {
      const m = /^\s*(?:<@!?)?(\d{17,20})?>?\s*$/.exec(String(b.discord_id));
      if (!m) return res.status(400).json({ error: 'Discord ID is the 17-20 digit number (Copy User ID).' });
      discordId = m[1] || '';
    }
    // Nickname: what `pending` lists instead of the IGN. Unique, and never another player's IGN,
    // so `confirm <nickname>` always means one person.
    const label = b.label === undefined ? row.label : String(b.label).replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
    if (label && label.toLowerCase() !== row.label.toLowerCase()) {
      const clash = listWallPlayers.all(userId).find((r) => r.player !== player
        && (r.label.toLowerCase() === label.toLowerCase() || r.player === label.toLowerCase()));
      if (clash) return res.status(409).json({ error: `"${label}" is already ${clash.display_name || clash.player}'s ${clash.player === label.toLowerCase() ? 'name' : 'nickname'}.` });
    }
    updateWallPlayerTax.run({
      user_id: userId, player,
      tax: b.tax === undefined ? row.tax : (b.tax ? 1 : 0),
      tax_admin: b.tax_admin === undefined ? row.tax_admin : (b.tax_admin ? 1 : 0),
      discord_id: discordId,
      // Nickname: the short name the tax list uses in chat instead of guessing one.
      label,
    });
    botManager.wallBroadcast(userId);
    res.json(listWallPlayers.all(userId));
  });

  router.delete('/wall/players/:player', (req, res) => {
    const userId = req.session.userId;
    deleteWallPlayer.run(userId, normalizePlayer(req.params.player));
    botManager.wallBroadcast(userId);
    res.json(listWallPlayers.all(userId));
  });

  // A sample "find me" card for the Matches view. Same parser and minor filter as the bot; never posts.
  router.get('/match/preview', (req, res) => {
    const query = parseMatchQuery(`find me ${String(req.query.q || '')}`);
    if (!query) return res.status(400).json({ error: 'Type what to look for, up to 60 characters.' });
    if (MINOR_RE.test(query)) return res.status(422).json({ error: 'The bot ignores this one: it reads as asking for a minor.' });
    res.json({ query, ...buildMatchProfile(query, Math.random, req.query.nsfw === '1') });
  });

  router.get('/reports', (req, res) => {
    res.json(listReports.all(req.session.userId));
  });

  // Console history: ?q= searches every kept day, else ?day=YYYY-MM-DD (default: just the day list).
  router.get('/chat', (req, res) => {
    const userId = req.session.userId;
    const q = String(req.query.q || '').trim().slice(0, 200);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const day = req.query.day === 'today' ? today : String(req.query.day || '');
    const lines = q ? searchChat(userId, q)
      : /^\d{4}-\d{2}-\d{2}$/.test(day) ? chatForDay(userId, day) : [];
    res.json({ today, days: listChatDays.all(userId), lines });
  });

  return router;
}
