import './env.js'; // must be first: loads .env into process.env before anything reads it
import express from 'express';
import session from 'express-session';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { router as authRouter, requireAuth } from './auth/siteAuth.js';
import { createApiRouter } from './api.js';
import BotManager from './bots/BotManager.js';
import Hub from './ws/hub.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// Interface to bind. Default 0.0.0.0 (all) for local dev; set HOST=127.0.0.1 on a shared
// VPS so the panel is only reachable over an SSH tunnel, never on the public IP.
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

const sessionParser = session({
  name: 'mcafk.sid',
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
});
app.use(sessionParser);

// ---- wiring ----
const hub = new Hub();
const botManager = new BotManager({ emitToUser: (userId, msg) => hub.emitToUser(userId, msg) });
hub.setBotManager(botManager);

// ---- routes ----
app.use('/auth', authRouter);
app.use('/api', requireAuth, createApiRouter({ botManager, emitToUser: (u, m) => hub.emitToUser(u, m) }));
app.use(express.static(PUBLIC_DIR));
// SPA fallback for non-API GETs.
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

// ---- server + WS upgrade (shares the session cookie) ----
const server = http.createServer(app);
server.on('error', (e) => { console.error('SERVER ERROR:', e); });
server.on('upgrade', (req, socket, head) => {
  sessionParser(req, {}, () => {
    if (!req.session?.authed) { socket.destroy(); return; }
    req.session.userId = req.session.userId || 'local';
    hub.handleUpgrade(req, socket, head);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`MC AFK console client listening on ${HOST}:${PORT}`);
});
