import express from 'express';
import { randomUUID } from 'node:crypto';
import {
  insertAccount, listAccounts, deleteAccount, setAccountLoad, setAllAccountsLoad,
  getAccountById, getSettings, updateSettings,
} from './db/db.js';
import { authenticateMicrosoft } from './auth/mcAuth.js';

const BOOL_KEYS = new Set([
  'show_chat', 'auto_reconnect', 'sneak', 'anti_afk', 'offline_mode', 'spam_enabled',
]);
const INT_KEYS = new Set(['login_delay_ms', 'spam_delay_ms']);

function normalizeSettingsPatch(body) {
  const patch = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (BOOL_KEYS.has(k)) patch[k] = v ? 1 : 0;
    else if (INT_KEYS.has(k)) patch[k] = Math.max(0, parseInt(v, 10) || 0);
    else patch[k] = String(v ?? '');
  }
  return patch;
}

export function createApiRouter({ botManager, emitToUser }) {
  const router = express.Router();

  // ---- Accounts ----
  router.get('/accounts', (req, res) => {
    res.json(listAccounts.all(req.session.userId));
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
      return res.status(201).json(account);
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
      emitToUser(userId, { type: 'accountAdded', account });
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
    res.json(listAccounts.all(userId));
  });

  router.post('/accounts/:id/load', (req, res) => {
    const userId = req.session.userId;
    const account = getAccountById.get(req.params.id, userId);
    if (!account) return res.status(404).json({ error: 'Not found' });
    const enabled = req.body?.enabled ? 1 : 0;
    setAccountLoad.run(enabled, account.id, userId);
    res.json({ ...account, load_enabled: enabled });
  });

  // ---- Settings ----
  router.get('/settings', (req, res) => {
    res.json(getSettings.get(req.session.userId));
  });

  router.put('/settings', (req, res) => {
    const userId = req.session.userId;
    const updated = updateSettings(userId, normalizeSettingsPatch(req.body));
    botManager.applySettings(userId);
    res.json(updated);
  });

  return router;
}
