import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// db.js opens its database at import time, so point it at a throwaway file first.
const TMP_DB = path.join(os.tmpdir(), `wallbot-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = TMP_DB;

const db = await import('../server/db/db.js');
const {
  default: WallBot, parseChatLine, compileTriggers, isQuietHours, normalizePlayer,
} = await import('../server/bots/WallBot.js');

const USER = 'local';

process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* already gone */ }
  }
});

// ---- parseChatLine ----

test('the "chat" pattern handles common public chat formats', () => {
  const cases = [
    ['Notch: check', 'Notch', 'check'],
    ['[Member] Notch: check', 'Notch', 'check'],
    ['[F] [Officer] Steve: verify 123456', 'Steve', 'verify 123456'],
    ['Notch > hi there', 'Notch', 'hi there'],
    ['§7[Member] §fNotch§7: check', 'Notch', 'check'],
  ];
  for (const [line, player, message] of cases) {
    const out = parseChatLine(line, 'chat');
    assert.ok(out, `expected a match for: ${line}`);
    assert.equal(out.player, player);
    assert.equal(out.message, message);
  }
});

// ---- DM mode (the default) ----

test('the default pattern reads private messages sent to the bot', () => {
  const cases = [
    ['[captunnel] [alienplanet] [wzul -> me] walls', 'wzul', 'walls'],
    ['[wzul -> me] check', 'wzul', 'check'],
    ['[captunnel] [alienplanet] [wzul -> me] verify 123456', 'wzul', 'verify 123456'],
    ['[captunnel] [alienplanet] [Notch_99 -> me] walls', 'Notch_99', 'walls'],
    ['[captunnel] [alienplanet] [wzul -> You] walls', 'wzul', 'walls'],
  ];
  for (const [line, player, message] of cases) {
    const out = parseChatLine(line, '');
    assert.ok(out, `expected a match for: ${line}`);
    assert.equal(out.player, player);
    assert.equal(out.message, message);
  }
});

test('DM mode ignores public chat, so a stray word cannot fire a trigger', () => {
  assert.equal(parseChatLine('[captunnel] [alienplanet] [Member] wzul: walls', ''), null);
  assert.equal(parseChatLine('wzul: walls', ''), null);
  assert.equal(parseChatLine('wzul > walls', ''), null);
});

test('DM mode ignores the bot\'s own outgoing whispers', () => {
  // Our replies render as "[me -> player]", the mirror of what we listen for. If this matched,
  // the bot would answer itself in a loop.
  assert.equal(parseChatLine('[me -> wzul] Wall check!', ''), null);
  assert.equal(parseChatLine('[captunnel] [me -> wzul] Your verification code is 123456', ''), null);
});

test('parseChatLine ignores lines that are not player chat', () => {
  assert.equal(parseChatLine('Notch joined the game', ''), null);
  assert.equal(parseChatLine('', ''), null);
  assert.equal(parseChatLine(null, ''), null);
});

test('parseChatLine honors a custom pattern', () => {
  const out = parseChatLine('<Notch> check', '^<(\\w+)> (.*)$');
  assert.deepEqual(out, { player: 'Notch', message: 'check' });
});

test('parseChatLine falls back to the default pattern when the custom one is invalid', () => {
  // An unbalanced group would throw at compile time; it must not escape into the chat handler.
  const out = parseChatLine('[wzul -> me] check', '^(unclosed');
  assert.deepEqual(out, { player: 'wzul', message: 'check' });
});

// ---- compileTriggers ----

test('compileTriggers matches every word in a comma list', () => {
  const match = compileTriggers('check, checked, walls, wall');
  for (const message of ['check', 'checked', 'walls', 'wall', 'I checked the walls', 'CHECK']) {
    assert.equal(match(message), true, `expected a match for: ${message}`);
  }
});

test('compileTriggers does not fire on substrings', () => {
  const match = compileTriggers('check, wall');
  for (const message of ['checkers', 'rechecking', 'wallet', 'firewalls']) {
    assert.equal(match(message), false, `expected no match for: ${message}`);
  }
});

test('compileTriggers accepts a /regex/ literal', () => {
  const match = compileTriggers('/^\\s*wall\\w*\\b/');
  assert.equal(match('walls done'), true);
  assert.equal(match('the wall is fine'), false); // anchored, so mid-sentence does not count
});

test('compileTriggers falls back to the word list when the regex is broken', () => {
  const match = compileTriggers('/(unclosed/');
  // Read as a word list, the literal text still forms a usable (if odd) trigger word.
  assert.doesNotThrow(() => match('anything'));
  assert.equal(match('anything'), false);
});

test('compileTriggers with an empty setting matches nothing', () => {
  const match = compileTriggers('  ');
  assert.equal(match('check'), false);
});

// ---- isQuietHours ----

test('isQuietHours covers same-day and wrap-around windows', () => {
  const at = (h, m = 0) => new Date(2026, 0, 15, h, m);
  // Same-day window 00:00-14:00
  assert.equal(isQuietHours(at(3), '00:00', '14:00'), true);
  assert.equal(isQuietHours(at(15), '00:00', '14:00'), false);
  assert.equal(isQuietHours(at(14), '00:00', '14:00'), false); // end is exclusive
  // Wrap-around window 22:00-06:00
  assert.equal(isQuietHours(at(23), '22:00', '06:00'), true);
  assert.equal(isQuietHours(at(2), '22:00', '06:00'), true);
  assert.equal(isQuietHours(at(12), '22:00', '06:00'), false);
});

test('isQuietHours is disabled by a blank or malformed bound', () => {
  const noon = new Date(2026, 0, 15, 12);
  assert.equal(isQuietHours(noon, '', '14:00'), false);
  assert.equal(isQuietHours(noon, '00:00', ''), false);
  assert.equal(isQuietHours(noon, 'nonsense', '14:00'), false);
  assert.equal(isQuietHours(noon, '08:00', '08:00'), false); // empty window
});

// ---- authorization, cooldown, verification ----

function harness(overrides = {}) {
  db.updateSettings(USER, {
    wall_enabled: 1,
    wall_require_verified: 1,
    wall_trigger: 'check, checked, walls, wall',
    // These cases exercise the authorization / cooldown / verification logic, so they pin the
    // parser to "chat" and feed public-chat lines. DM mode gets its own end-to-end case below.
    wall_chat_pattern: 'chat',
    wall_to_minecraft: 0, // keep output on the console path so nothing is queued behind a timer
    wall_to_discord: 0,
    raid_enabled: 0,
    ...overrides,
  });
  const session = {
    account: { id: 'acc1', username: 'wallbot' },
    bot: { username: 'wallbot' },
    status: 'online',
    sendChat() {},
  };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  return { wb, session };
}

function clearWallTables() {
  db.resetWallStats(USER);
  for (const row of db.listWallPlayers.all(USER)) db.deleteWallPlayer.run(USER, row.player);
}

test('an unauthorized player\'s trigger writes nothing', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, '[Member] Notch: check');
    assert.deepEqual(db.allWallCheckers.all(USER), []);
    assert.equal(db.getWallState.get(USER)?.total_checks || 0, 0);
  } finally { wb.stopAll(); }
});

test('a correct code within the window verifies the player', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify');
    const pending = wb.users.get(USER).pendingCodes.get('notch');
    assert.ok(pending, 'expected a pending code for notch');

    wb.handleChat(USER, session, `Notch: verify ${pending.code}`);
    const row = db.getWallPlayer.get(USER, 'notch');
    assert.ok(row && row.verified, 'notch should be verified');
  } finally { wb.stopAll(); }
});

test('a wrong code does not verify, and burns the pending entry', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify');
    const pending = wb.users.get(USER).pendingCodes.get('notch');
    const wrong = pending.code === '000000' ? '111111' : '000000';

    wb.handleChat(USER, session, `Notch: verify ${wrong}`);
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined);
    assert.equal(wb.users.get(USER).pendingCodes.has('notch'), false);
  } finally { wb.stopAll(); }
});

test('an expired code does not verify', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify');
    const pending = wb.users.get(USER).pendingCodes.get('notch');
    pending.expiresAt = Date.now() - 1; // age it out

    wb.handleChat(USER, session, `Notch: verify ${pending.code}`);
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined);
  } finally { wb.stopAll(); }
});

test('a code issued to one player cannot verify another', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify');
    const code = wb.users.get(USER).pendingCodes.get('notch').code;

    wb.handleChat(USER, session, `Steve: verify ${code}`);
    assert.equal(db.getWallPlayer.get(USER, 'steve'), undefined, 'steve must not be verified');
    assert.ok(db.getWallPlayer.get(USER, 'notch') === undefined, 'notch is not verified either');
  } finally { wb.stopAll(); }
});

test('a verified player is counted once, then blocked by the cooldown', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    db.upsertWallPlayer.run({ user_id: USER, player: 'notch', verified: 1, label: '', added_at: Date.now() });

    wb.handleChat(USER, session, '[Member] Notch: check');
    assert.equal(db.getWallPlayer.get(USER, 'notch').verified, 1);
    assert.equal(db.allWallCheckers.all(USER).find((r) => r.player === 'notch').checks, 1);

    wb.handleChat(USER, session, '[Member] Notch: walls');
    assert.equal(db.allWallCheckers.all(USER).find((r) => r.player === 'notch').checks, 1,
      'a second check inside the cooldown must not count');
  } finally { wb.stopAll(); }
});

test('with verification off, any player counts', () => {
  clearWallTables();
  const { wb, session } = harness({ wall_require_verified: 0 });
  try {
    wb.handleChat(USER, session, 'Randomguy: check');
    assert.equal(db.allWallCheckers.all(USER).find((r) => r.player === 'randomguy').checks, 1);
  } finally { wb.stopAll(); }
});

test('DM mode end to end: verify by whisper, then log a check by whisper', () => {
  clearWallTables();
  const { wb, session } = harness({ wall_chat_pattern: '' }); // '' = DM, the shipping default
  try {
    // A public-chat trigger must be ignored entirely in DM mode.
    wb.handleChat(USER, session, '[captunnel] [alienplanet] [Member] wzul: walls');
    assert.deepEqual(db.allWallCheckers.all(USER), [], 'public chat must not count in DM mode');

    // Verify over whisper.
    wb.handleChat(USER, session, '[captunnel] [alienplanet] [wzul -> me] verify');
    const pending = wb.users.get(USER).pendingCodes.get('wzul');
    assert.ok(pending, 'expected a pending code for wzul');
    wb.handleChat(USER, session, `[captunnel] [alienplanet] [wzul -> me] verify ${pending.code}`);
    assert.equal(db.getWallPlayer.get(USER, 'wzul').verified, 1);

    // Now a whispered trigger counts.
    wb.handleChat(USER, session, '[captunnel] [alienplanet] [wzul -> me] walls');
    assert.equal(db.allWallCheckers.all(USER).find((r) => r.player === 'wzul').checks, 1);
  } finally { wb.stopAll(); }
});

test('the whisper command is configurable', () => {
  clearWallTables();
  const sent = [];
  db.updateSettings(USER, {
    wall_enabled: 1, wall_require_verified: 1, wall_chat_pattern: '',
    wall_to_minecraft: 1, wall_to_discord: 0, wall_msg_command: '/w',
  });
  const session = {
    account: { id: 'acc1', username: 'wallbot' },
    bot: { username: 'wallbot' },
    status: 'online',
    sendChat: (m) => sent.push(m),
  };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    wb._whisper(USER, 'wzul', 'hello');
    // _enqueue spaces sends behind a timer; read the queued line directly.
    const queued = wb.users.get(USER).queue.concat(sent);
    assert.ok(queued.some((l) => l.startsWith('/w wzul ')), `expected /w, got: ${JSON.stringify(queued)}`);
  } finally { wb.stopAll(); }
});

test('the bot ignores its own chat', () => {
  clearWallTables();
  const { wb, session } = harness({ wall_require_verified: 0 });
  try {
    wb.handleChat(USER, session, 'wallbot: check');
    assert.deepEqual(db.allWallCheckers.all(USER), []);
  } finally { wb.stopAll(); }
});

// ---- reset ----

test('resetWallStats zeroes the scoreboard but keeps the roster', () => {
  clearWallTables();
  db.upsertWallPlayer.run({ user_id: USER, player: 'notch', verified: 1, label: 'YK', added_at: Date.now() });
  db.incWallCheck.run({ user_id: USER, player: 'notch', last_check: Date.now() });
  db.upsertWallState.run({ user_id: USER, total_checks: 1, last_check_at: Date.now() });

  db.resetWallStats(USER);

  assert.deepEqual(db.allWallCheckers.all(USER), []);
  assert.equal(db.getWallState.get(USER).total_checks, 0);
  assert.equal(db.listWallPlayers.all(USER).length, 1, 'the roster must survive a reset');
  assert.equal(db.getWallPlayer.get(USER, 'notch').verified, 1);
});

test('normalizePlayer folds casing so one player cannot occupy two rows', () => {
  assert.equal(normalizePlayer('  NoTcH '), 'notch');
  assert.equal(normalizePlayer(null), '');
});
