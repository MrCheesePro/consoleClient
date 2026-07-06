import { WebSocketServer } from 'ws';

/**
 * Tracks WebSocket connections grouped by site user and routes inbound control
 * messages to the BotManager. All messages are scoped to the authenticated user
 * derived from the session at upgrade time — clients cannot target other users.
 */
export default class Hub {
  constructor() {
    this.wss = new WebSocketServer({ noServer: true });
    this.byUser = new Map(); // userId -> Set<ws>
    this.botManager = null;
  }

  setBotManager(botManager) { this.botManager = botManager; }

  emitToUser(userId, message) {
    const set = this.byUser.get(userId);
    if (!set) return;
    const data = JSON.stringify(message);
    for (const ws of set) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  handleUpgrade(req, socket, head) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const userId = req.session?.userId;
      if (!userId) { ws.close(); return; }

      if (!this.byUser.has(userId)) this.byUser.set(userId, new Set());
      this.byUser.get(userId).add(ws);

      // Send current bot status so a (re)connecting client is in sync.
      ws.send(JSON.stringify({ type: 'statusSnapshot', statuses: this.botManager.statusSnapshot(userId) }));
      // And the latest stored leaderboard, if any.
      const lb = this.botManager.leaderboardSnapshot(userId);
      if (lb) ws.send(JSON.stringify({ type: 'leaderboard', entries: lb.entries, updatedAt: lb.updatedAt }));

      ws.on('message', (raw) => this._onMessage(userId, raw));
      ws.on('close', () => {
        const set = this.byUser.get(userId);
        if (set) { set.delete(ws); if (set.size === 0) this.byUser.delete(userId); }
      });
    });
  }

  _onMessage(userId, raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const bm = this.botManager;
    const target = msg.accountId || 'all';
    switch (msg.type) {
      case 'connect': bm.connect(userId, msg.accountIds || null); break;
      case 'disconnect': bm.disconnect(userId, msg.accountIds || null); break;
      case 'sendChat': bm.sendChat(userId, target, msg.message); break;
      case 'dropAll': bm.dropAll(userId, target); break;
      case 'equipArmor': bm.equipArmor(userId, target); break;
      case 'useItem': bm.useItem(userId, target); break;
      case 'refreshLeaderboard': bm.refreshLeaderboard(userId); break;
      default: break;
    }
  }
}
