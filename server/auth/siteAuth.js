import express from 'express';
import crypto from 'node:crypto';
import { DEFAULT_USER_ID } from '../db/db.js';

// Single-user mode: one shared password unlocks the panel.
// Override with the APP_PASSWORD env var; defaults to "turtlegang".
const PASSWORD = process.env.APP_PASSWORD || 'turtlegang';

function passwordMatches(input) {
  const a = Buffer.from(String(input));
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const router = express.Router();

router.get('/status', (req, res) => {
  res.json({ authed: !!req.session?.authed });
});

router.post('/login', (req, res) => {
  if (!passwordMatches(req.body?.password || '')) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  req.session.authed = true;
  req.session.userId = DEFAULT_USER_ID;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Middleware guard for authenticated REST routes.
export function requireAuth(req, res, next) {
  if (!req.session?.authed) return res.status(401).json({ error: 'Not authenticated' });
  req.session.userId = DEFAULT_USER_ID;
  next();
}
