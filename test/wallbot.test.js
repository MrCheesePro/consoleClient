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
  fillPlaceholders, formatDuration, formatClock,
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
    wall_verify_password: 'turtles',
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

test('the password issues a code but does not verify on its own', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify turtles');
    const pending = wb.users.get(USER).pendingCodes.get('notch');
    assert.ok(pending, 'expected a pending code');
    assert.match(pending.code, /^\d{6}$/, 'code should be six digits');
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined,
      'the password alone must not grant access');
  } finally { wb.stopAll(); }
});

test('the issued code completes verification', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify turtles');
    const { code } = wb.users.get(USER).pendingCodes.get('notch');

    wb.handleChat(USER, session, `Notch: verify ${code}`);
    assert.equal(db.getWallPlayer.get(USER, 'notch').verified, 1);
    assert.equal(wb.users.get(USER).pendingCodes.has('notch'), false, 'code should be consumed');
  } finally { wb.stopAll(); }
});

test('the code expires after 15 minutes', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify turtles');
    const pending = wb.users.get(USER).pendingCodes.get('notch');

    // Confirm the window really is 15 minutes, then age it past the edge.
    const ttlMinutes = Math.round((pending.expiresAt - Date.now()) / 60000);
    assert.equal(ttlMinutes, 15);
    pending.expiresAt = Date.now() - 1;

    wb.handleChat(USER, session, `Notch: verify ${pending.code}`);
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined, 'an expired code must not work');
  } finally { wb.stopAll(); }
});

test('re-sending the password repeats the same code instead of minting a new one', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify turtles');
    const first = wb.users.get(USER).pendingCodes.get('notch').code;
    wb.handleChat(USER, session, 'Notch: verify turtles');
    const second = wb.users.get(USER).pendingCodes.get('notch').code;
    assert.equal(second, first);
  } finally { wb.stopAll(); }
});

test('a code issued to one player cannot verify another', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify turtles');
    const { code } = wb.users.get(USER).pendingCodes.get('notch');

    wb.handleChat(USER, session, `Steve: verify ${code}`);
    assert.equal(db.getWallPlayer.get(USER, 'steve'), undefined, 'steve must not be verified');
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined, 'notch has not confirmed yet');
  } finally { wb.stopAll(); }
});

test('a wrong password issues no code and does not verify', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify hunter2');
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined);
    assert.equal(wb.users.get(USER).pendingCodes.has('notch'), false, 'no code for a bad password');
  } finally { wb.stopAll(); }
});

test('a wrong code does not verify', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify turtles');
    const { code } = wb.users.get(USER).pendingCodes.get('notch');
    const wrong = code === '000000' ? '111111' : '000000';

    wb.handleChat(USER, session, `Notch: verify ${wrong}`);
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined);
  } finally { wb.stopAll(); }
});

test('the password is case-sensitive and ignores surrounding whitespace', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    wb.handleChat(USER, session, 'Notch: verify TURTLES');
    assert.equal(wb.users.get(USER).pendingCodes.has('notch'), false, 'wrong case must not pass');

    wb.handleChat(USER, session, 'Steve: verify   turtles  ');
    assert.ok(wb.users.get(USER).pendingCodes.has('steve'), 'padding should be trimmed');
  } finally { wb.stopAll(); }
});

test('an all-digit password is not mistaken for a code', () => {
  clearWallTables();
  const { wb, session } = harness({ wall_verify_password: '123456' });
  try {
    wb.handleChat(USER, session, 'Notch: verify 123456');
    const pending = wb.users.get(USER).pendingCodes.get('notch');
    assert.ok(pending, 'a six-digit password should still issue a code');
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined, 'and must not verify outright');

    wb.handleChat(USER, session, `Notch: verify ${pending.code}`);
    assert.equal(db.getWallPlayer.get(USER, 'notch').verified, 1);
  } finally { wb.stopAll(); }
});

test('with no password set, self-verification fails shut', () => {
  clearWallTables();
  const { wb, session } = harness({ wall_verify_password: '' });
  try {
    wb.handleChat(USER, session, 'Notch: verify');
    wb.handleChat(USER, session, 'Notch: verify anything');
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined,
      'a blank password must close self-verification, not open it to everyone');
  } finally { wb.stopAll(); }
});

test('wrong guesses are rate limited', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    for (let i = 0; i < 10; i++) wb.handleChat(USER, session, `Notch: verify guess${i}`);
    const attempts = wb.users.get(USER).verifyAttempts.get('notch');
    assert.equal(attempts.length, 5, 'should stop recording after the hourly cap');

    // Locked out even with the correct password once the cap is hit — no code is issued.
    wb.handleChat(USER, session, 'Notch: verify turtles');
    assert.equal(wb.users.get(USER).pendingCodes.has('notch'), false);
    assert.equal(db.getWallPlayer.get(USER, 'notch'), undefined);
  } finally { wb.stopAll(); }
});

test('a successful verification clears the attempt counter', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    for (let i = 0; i < 3; i++) wb.handleChat(USER, session, `Notch: verify guess${i}`);
    wb.handleChat(USER, session, 'Notch: verify turtles');
    const { code } = wb.users.get(USER).pendingCodes.get('notch');
    wb.handleChat(USER, session, `Notch: verify ${code}`);

    assert.equal(db.getWallPlayer.get(USER, 'notch').verified, 1);
    assert.equal(wb.users.get(USER).verifyAttempts.has('notch'), false,
      'earlier fumbles should not count against them afterwards');
  } finally { wb.stopAll(); }
});

test('asking how to verify does not spend an attempt', () => {
  clearWallTables();
  const { wb, session } = harness();
  try {
    for (let i = 0; i < 5; i++) wb.handleChat(USER, session, 'Notch: verify');
    assert.equal(wb.users.get(USER).verifyAttempts.get('notch'), undefined,
      'a bare "verify" is a help request, not a guess');

    wb.handleChat(USER, session, 'Notch: verify turtles');
    const { code } = wb.users.get(USER).pendingCodes.get('notch');
    wb.handleChat(USER, session, `Notch: verify ${code}`);
    assert.ok(db.getWallPlayer.get(USER, 'notch')?.verified);
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

    // Verify over whisper: password first, then the code it hands back.
    wb.handleChat(USER, session, '[captunnel] [alienplanet] [wzul -> me] verify turtles');
    const { code } = wb.users.get(USER).pendingCodes.get('wzul');
    assert.equal(db.getWallPlayer.get(USER, 'wzul'), undefined, 'password alone is not enough');

    wb.handleChat(USER, session, `[captunnel] [alienplanet] [wzul -> me] verify ${code}`);
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

// ---- reminder templates ----

test('fillPlaceholders substitutes known keys and leaves unknown ones alone', () => {
  const out = fillPlaceholders(
    'WALLS : {minutes}m since check, {total} total, last {player}, keep {mystery}',
    { minutes: 12, total: 40, player: 'wzul' },
  );
  assert.equal(out, 'WALLS : 12m since check, 40 total, last wzul, keep {mystery}');
});

test('fillPlaceholders handles a repeated key and a template with none', () => {
  assert.equal(fillPlaceholders('{minutes}/{minutes}', { minutes: 5 }), '5/5');
  assert.equal(fillPlaceholders('Check Walls', { minutes: 5 }), 'Check Walls');
  assert.equal(fillPlaceholders(null, { minutes: 5 }), '');
});

test('a multi-line reminder sends one chat message per line, with minutes filled in', () => {
  clearWallTables();
  const sent = [];
  db.updateSettings(USER, {
    wall_enabled: 1,
    wall_to_minecraft: 1,
    wall_to_discord: 0,
    wall_interval_ms: 30000,
    wall_quiet_start: '',
    wall_quiet_end: '',
    wall_reminder_message: 'Check Walls\n/msg captunnel WALLS : Minutes since last checked: {minutes}',
  });
  const session = {
    account: { id: 'acc1', username: 'wallbot' },
    bot: { username: 'wallbot' },
    status: 'online',
    sendChat: (m) => sent.push(m),
  };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    const state = wb._stateFor(USER);
    state.wallActive = true;
    state.lastCheckAt = Date.now() - 12 * 60 * 1000; // 12 minutes ago

    wb._tick();

    // _enqueue spaces sends behind a timer, so read the queue plus anything already flushed.
    const lines = wb.users.get(USER).queue.concat(sent);
    assert.deepEqual(lines, [
      'Check Walls',
      '/msg captunnel WALLS : Minutes since last checked: 12',
    ]);
  } finally { wb.stopAll(); }
});

test('a one-line reminder fills in both {minutes} and {player}', () => {
  clearWallTables();
  const sent = [];
  db.updateSettings(USER, {
    wall_enabled: 1, wall_to_minecraft: 1, wall_to_discord: 0,
    wall_interval_ms: 30000, wall_quiet_start: '', wall_quiet_end: '',
    wall_reminder_message: 'Check Walls /msg captunnel WALLS : Minutes since last checked: {minutes} by {player}',
  });
  // Someone checked, so {player} has a real answer.
  db.incWallCheck.run({ user_id: USER, player: 'wzul', last_check: Date.now() });

  const session = {
    account: { id: 'acc1', username: 'wallbot' },
    bot: { username: 'wallbot' },
    status: 'online',
    sendChat: (m) => sent.push(m),
  };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    const state = wb._stateFor(USER);
    state.wallActive = true;
    state.lastCheckAt = Date.now() - 7 * 60 * 1000;

    wb._tick();
    const lines = wb.users.get(USER).queue.concat(sent);
    assert.deepEqual(lines, [
      'Check Walls /msg captunnel WALLS : Minutes since last checked: 7 by wzul',
    ]);
  } finally { wb.stopAll(); }
});

test('{player} survives a restart, and reads "nobody" before any check', () => {
  clearWallTables();
  // Nothing recorded yet.
  assert.equal(db.lastWallChecker.get(USER), undefined);

  db.incWallCheck.run({ user_id: USER, player: 'steve', last_check: Date.now() - 5000 });
  db.incWallCheck.run({ user_id: USER, player: 'wzul', last_check: Date.now() });
  // Most recent wins, and it comes from the table rather than process memory.
  assert.equal(db.lastWallChecker.get(USER).player, 'wzul');
});

test('the reminder no longer has an elapsed-time suffix appended behind the template', () => {
  clearWallTables();
  const sent = [];
  db.updateSettings(USER, {
    wall_enabled: 1, wall_to_minecraft: 1, wall_to_discord: 0,
    wall_interval_ms: 30000, wall_quiet_start: '', wall_quiet_end: '',
    wall_reminder_message: 'Check Walls',
  });
  const session = {
    account: { id: 'acc1', username: 'wallbot' },
    bot: { username: 'wallbot' },
    status: 'online',
    sendChat: (m) => sent.push(m),
  };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    const state = wb._stateFor(USER);
    state.wallActive = true;
    state.lastCheckAt = Date.now() - 9 * 60 * 1000;

    wb._tick();
    const lines = wb.users.get(USER).queue.concat(sent);
    assert.deepEqual(lines, ['Check Walls'], 'the template is sent verbatim');
  } finally { wb.stopAll(); }
});

// ---- reminder cadence vs. elapsed time ----

function tickHarness(overrides = {}) {
  const sent = [];
  db.updateSettings(USER, {
    wall_enabled: 1, wall_to_minecraft: 1, wall_to_discord: 0,
    wall_interval_ms: 30000, wall_quiet_start: '', wall_quiet_end: '',
    wall_reminder_message: '{minutes}',
    ...overrides,
  });
  const session = {
    account: { id: 'acc1', username: 'wallbot' },
    bot: { username: 'wallbot' },
    status: 'online',
    sendChat: (m) => sent.push(m),
  };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  const drain = () => {
    const out = wb.users.get(USER).queue.concat(sent);
    wb.users.get(USER).queue.length = 0;
    sent.length = 0;
    return out;
  };
  return { wb, drain };
}

test('minutes unchecked keeps climbing across repeated reminders', () => {
  clearWallTables();
  const { wb, drain } = tickHarness();
  try {
    const state = wb._stateFor(USER);
    state.wallActive = true;
    state.lastCheckAt = Date.now() - 60 * 60 * 1000; // an hour since anyone checked

    wb._tick();
    assert.deepEqual(drain(), ['60'], 'first reminder reports the real elapsed time');

    // Let the repeat interval lapse and fire again. The elapsed figure must not reset.
    state.lastReminderAt = Date.now() - 31000;
    wb._tick();
    assert.deepEqual(drain(), ['60'], 'second reminder still measures from the last real check');
  } finally { wb.stopAll(); }
});

test('a reminder does not overwrite the stored last-check time', () => {
  clearWallTables();
  const { wb } = tickHarness();
  try {
    const state = wb._stateFor(USER);
    state.wallActive = true;
    const checkedAt = Date.now() - 45 * 60 * 1000;
    state.lastCheckAt = checkedAt;

    wb._tick();
    assert.equal(state.lastCheckAt, checkedAt, 'the last-check clock must not move when we speak');
    assert.ok(state.lastReminderAt > 0, 'the reminder clock is what advances');
  } finally { wb.stopAll(); }
});

test('reminders repeat no faster than the interval', () => {
  clearWallTables();
  const { wb, drain } = tickHarness();
  try {
    const state = wb._stateFor(USER);
    state.wallActive = true;
    state.lastCheckAt = Date.now() - 60 * 60 * 1000;

    wb._tick();
    assert.equal(drain().length, 1);
    wb._tick(); // immediately again — inside the interval
    assert.equal(drain().length, 0, 'must not repeat until the interval lapses');
  } finally { wb.stopAll(); }
});

test('a real check restarts the reminder cycle', () => {
  clearWallTables();
  const { wb } = tickHarness({ wall_require_verified: 0, wall_chat_pattern: 'chat' });
  try {
    const state = wb._stateFor(USER);
    state.wallActive = true;
    state.lastCheckAt = Date.now() - 60 * 60 * 1000;
    wb._tick();
    assert.ok(state.lastReminderAt > 0);

    // Must be the same object handleChat will resolve — it compares session identity.
    wb.handleChat(USER, wb.resolveSession(USER), 'Notch: check');
    assert.equal(state.lastReminderAt, 0, 'the cycle resets so the next reminder is a fresh one');
  } finally { wb.stopAll(); }
});

// ---- check confirmation ----

test('the check confirmation follows its own template', () => {
  clearWallTables();
  const { wb, drain } = tickHarness({
    wall_require_verified: 0,
    wall_chat_pattern: 'chat',
    wall_check_message: 'Walls checked by {player} [{checks}]',
  });
  try {
    const session = wb.resolveSession(USER);
    wb.handleChat(USER, session, 'AceSoft: check');
    assert.deepEqual(drain(), ['Walls checked by acesoft [1]']);

    // A second check by the same player reports their running count.
    wb.users.get(USER).cooldowns.clear();
    wb.handleChat(USER, session, 'AceSoft: check');
    assert.deepEqual(drain(), ['Walls checked by acesoft [2]']);
  } finally { wb.stopAll(); }
});

// ---- Discord routing ----

function discordHarness(overrides) {
  db.updateSettings(USER, {
    wall_enabled: 1, raid_enabled: 1,
    wall_to_minecraft: 0,
    wall_to_discord: 1, wall_discord_webhook: 'https://discord.test/wall',
    raid_delay_ms: 3000,
    raid_message: 'RAID ALERT',
    ...overrides,
  });
  const session = {
    account: { id: 'acc1', username: 'wallbot' },
    bot: { username: 'wallbot' },
    status: 'online',
    sendChat() {},
  };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  const posts = [];
  wb._postDiscord = (userId, webhook, text) => { posts.push({ webhook, text }); };
  return { wb, posts };
}

test('raid alerts go to their own webhook when one is configured', () => {
  const { wb, posts } = discordHarness({
    raid_to_discord: 1, raid_discord_webhook: 'https://discord.test/raid',
  });
  try {
    wb._send(USER, 'routine wall reminder');
    wb._beginRaid(USER, db.getSettings.get(USER), null);

    assert.equal(posts[0].webhook, 'https://discord.test/wall', 'wall traffic uses the wall hook');
    assert.equal(posts[1].webhook, 'https://discord.test/raid', 'the raid uses the raid hook');
    assert.equal(posts[1].text, 'RAID ALERT');
  } finally { wb.stopAll(); }
});

test('a raid falls back to the wall webhook when its own URL is blank', () => {
  const { wb, posts } = discordHarness({
    raid_to_discord: 1, raid_discord_webhook: '',
  });
  try {
    wb._beginRaid(USER, db.getSettings.get(USER), null);
    assert.equal(posts.length, 1, 'the alert must not vanish');
    assert.equal(posts[0].webhook, 'https://discord.test/wall');
  } finally { wb.stopAll(); }
});

test('with the raid toggle off, raids follow the wall Discord settings', () => {
  const { wb, posts } = discordHarness({
    raid_to_discord: 0, raid_discord_webhook: 'https://discord.test/raid',
  });
  try {
    wb._beginRaid(USER, db.getSettings.get(USER), null);
    assert.equal(posts[0].webhook, 'https://discord.test/wall',
      'an unconfirmed raid hook must not be used');
  } finally { wb.stopAll(); }
});

test('a raid still reaches Discord when wall Discord output is switched off', () => {
  const { wb, posts } = discordHarness({
    wall_to_discord: 0,
    raid_to_discord: 1, raid_discord_webhook: 'https://discord.test/raid',
  });
  try {
    wb._send(USER, 'routine wall reminder');
    assert.equal(posts.length, 0, 'wall traffic stays off');

    wb._beginRaid(USER, db.getSettings.get(USER), null);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].webhook, 'https://discord.test/raid');
  } finally { wb.stopAll(); }
});

// ---- Discord embed payload ----
// These stub global fetch rather than _postDiscord, so the JSON actually sent is what's asserted.

async function capturePost(configure) {
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    posts.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 204 };
  };
  try {
    await configure();
    // _postDiscord is async and not awaited by _send; let the microtasks settle.
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = realFetch;
  }
  return posts;
}

test('a reminder posts a Discord embed with title, colour, body and timestamp', async () => {
  clearWallTables();
  db.updateSettings(USER, {
    wall_enabled: 1, wall_to_minecraft: 0,
    wall_to_discord: 1, wall_discord_webhook: 'https://discord.test/wall',
    wall_interval_ms: 30000, wall_quiet_start: '', wall_quiet_end: '',
    wall_reminder_message: 'Check Walls',
    wall_discord_message: 'Minutes Unchecked: **{minutes}**\nLast Checker: **{player}** (Total Checks: {checks})',
  });
  db.incWallCheck.run({ user_id: USER, player: 'acesoft', last_check: Date.now() });
  db.incWallCheck.run({ user_id: USER, player: 'acesoft', last_check: Date.now() });

  const session = { account: { id: 'a', username: 'wallbot' }, bot: { username: 'wallbot' }, status: 'online', sendChat() {} };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    const posts = await capturePost(async () => {
      const state = wb._stateFor(USER);
      state.wallActive = true;
      state.lastCheckAt = Date.now() - 255 * 60 * 1000;
      wb._tick();
    });

    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://discord.test/wall');
    const embed = posts[0].body.embeds[0];
    assert.equal(embed.title, 'Wall Check Alert!');
    assert.equal(embed.color, 0xED4245);
    assert.equal(embed.description,
      'Minutes Unchecked: **255**\nLast Checker: **acesoft** (Total Checks: 2)');
    assert.ok(!Number.isNaN(Date.parse(embed.timestamp)), 'timestamp must be ISO-8601');
    assert.equal(posts[0].body.content, undefined, 'an embed post carries no plain content');
  } finally { wb.stopAll(); }
});

test('a check posts a log embed to the logs channel', async () => {
  clearWallTables();
  db.updateSettings(USER, {
    wall_enabled: 1, wall_to_minecraft: 0, wall_require_verified: 0, wall_chat_pattern: 'chat',
    wall_to_discord: 1, wall_discord_webhook: 'https://discord.test/wall',
    check_to_discord: 1, check_discord_webhook: 'https://discord.test/logs',
  });
  const session = { account: { id: 'a', username: 'noobtech' }, bot: { username: 'noobtech' }, status: 'online', sendChat() {} };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    // Give them some history and a gap since the previous check.
    db.incWallCheck.run({ user_id: USER, player: 'zghostx', last_check: Date.now() });
    const state = wb._stateFor(USER);
    state.lastCheckAt = Date.now() - ((6 * 3600) + (59 * 60) + 26) * 1000;

    const posts = await capturePost(async () => {
      wb.handleChat(USER, session, 'zGhostx: check');
    });

    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://discord.test/logs', 'goes to the logs channel, not wall');

    const embed = posts[0].body.embeds[0];
    assert.equal(embed.color, 0x22D3EE);
    assert.equal(embed.author.name, 'zghostx recorded a WALL CHECK.');
    assert.match(embed.author.icon_url, /mc-heads\.net\/avatar\/zghostx/);
    assert.equal(embed.footer.text, 'noobtech');
    assert.ok(!Number.isNaN(Date.parse(embed.timestamp)));
    assert.equal(embed.description, undefined, 'fields say it all; no duplicate body line');

    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.match(byName['Clear at'], /^`\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}`$/);
    assert.equal(byName['Time since last check'], '`6h 59m 26s`');
    assert.equal(byName['Raid Checks'], '`0`');
    assert.equal(byName['Wall Checks'], '`2`');
  } finally { wb.stopAll(); }
});

test('a check during a raid is logged as a raid check', async () => {
  clearWallTables();
  db.updateSettings(USER, {
    wall_enabled: 1, raid_enabled: 1, wall_to_minecraft: 0,
    wall_require_verified: 0, wall_chat_pattern: 'chat',
    check_to_discord: 1, check_discord_webhook: 'https://discord.test/logs',
    wall_to_discord: 0,
  });
  const session = { account: { id: 'a', username: 'noobtech' }, bot: { username: 'noobtech' }, status: 'online', sendChat() {} };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    wb._stateFor(USER).raidActive = true;

    const posts = await capturePost(async () => {
      wb.handleChat(USER, session, 'zGhostx: check');
    });

    const embed = posts[0].body.embeds[0];
    assert.equal(embed.author.name, 'zghostx recorded a RAID CHECK.');
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.equal(byName['Raid Checks'], '`1`');
    assert.equal(byName['Wall Checks'], '`0`', 'the two counters are mutually exclusive');

    const row = db.allWallCheckers.all(USER).find((r) => r.player === 'zghostx');
    assert.equal(row.raid_checks, 1);
    assert.equal(row.checks, 0);
  } finally { wb.stopAll(); }
});

test('checks fall back to the wall webhook when no logs channel is set', async () => {
  clearWallTables();
  db.updateSettings(USER, {
    wall_enabled: 1, wall_to_minecraft: 0, wall_require_verified: 0, wall_chat_pattern: 'chat',
    wall_to_discord: 1, wall_discord_webhook: 'https://discord.test/wall',
    check_to_discord: 0, check_discord_webhook: '',
  });
  const session = { account: { id: 'a', username: 'noobtech' }, bot: { username: 'noobtech' }, status: 'online', sendChat() {} };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    const posts = await capturePost(async () => {
      wb.handleChat(USER, session, 'zGhostx: check');
    });
    assert.equal(posts.length, 1, 'the log must not vanish');
    assert.equal(posts[0].url, 'https://discord.test/wall');
  } finally { wb.stopAll(); }
});

// ---- factions leaderboard ----

const { parseLeaderboard } = await import('../server/bots/BotManager.js');

test('parseLeaderboard reads a tagged "Base Points" board', () => {
  // Verbatim from a real /f base reply, tags and all — this exact shape used to parse as nothing.
  const entries = parseLeaderboard([
    '[captunnel] Top Base Factions (1/5)',
    '[captunnel] 1. TurtleGang - 100,898 Base Points',
    '[captunnel] 2. RastaMouse - 73,376 Base Points',
    '[captunnel] 3. Zomboid - 56,144 Base Points',
    '[captunnel] 4. Dominion - 35,796 Base Points',
    '[captunnel] 5. EzBuckets - 11,867 Base Points',
    '[captunnel] 6. Thanos - 10,732 Base Points',
    '[captunnel] 7. RaidEvent - 9,000 Base Points',
    '[captunnel] 8. Certi - 7,225 Base Points',
    '[captunnel] 9. Tectonic - 6,894 Base Points',
    '[captunnel] 10. TBS - 6,286 Base Points',
    '[captunnel]',
  ]);

  assert.equal(entries.length, 10);
  assert.deepEqual(entries[0], { rank: 1, name: 'TurtleGang', points: 100898, gain: null });
  assert.deepEqual(entries[9], { rank: 10, name: 'TBS', points: 6286, gain: null });
});

test('parseLeaderboard still reads the untagged "Faction Points" board with gains', () => {
  const entries = parseLeaderboard([
    'Top Factions (1/5)',
    '1. TurtleGang - 189,101 Faction Points (+24,221)',
    '2. RastaMouse - 73,376 Faction Points (-1,004)',
  ]);
  assert.deepEqual(entries, [
    { rank: 1, name: 'TurtleGang', points: 189101, gain: 24221 },
    { rank: 2, name: 'RastaMouse', points: 73376, gain: -1004 },
  ]);
});

test('parseLeaderboard tolerates colour codes and bare "Points"', () => {
  const entries = parseLeaderboard([
    '§7[captunnel] §61. §fTurtleGang §7- §e100,898 Points',
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'TurtleGang');
  assert.equal(entries[0].points, 100898);
});

test('parseLeaderboard ignores chatter and caps at ten', () => {
  assert.deepEqual(parseLeaderboard(['[captunnel] Top Base Factions (1/5)', 'hello', '']), []);
  const many = Array.from({ length: 15 }, (_, i) => `${i + 1}. F${i + 1} - ${i + 1} Base Points`);
  assert.equal(parseLeaderboard(many).length, 10);
});

test('the leaderboard posts a Discord embed and never echoes into Minecraft', async () => {
  clearWallTables();
  const sent = [];
  db.updateSettings(USER, {
    wall_enabled: 1, wall_to_minecraft: 1,
    wall_to_discord: 1, wall_discord_webhook: 'https://discord.test/wall',
    leaderboard_to_discord: 1, leaderboard_discord_webhook: 'https://discord.test/board',
  });
  const session = { account: { id: 'a', username: 'captunnel' }, bot: { username: 'captunnel' }, status: 'online', sendChat: (m) => sent.push(m) };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    const posts = await capturePost(async () => {
      wb.postLeaderboard(USER, [
        { rank: 1, name: 'TurtleGang', points: 100898, gain: null },
        { rank: 2, name: 'RastaMouse', points: 73376, gain: -1004 },
      ]);
    });

    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://discord.test/board', 'uses its own channel');

    const embed = posts[0].body.embeds[0];
    assert.equal(embed.title, 'Top Factions');
    assert.equal(embed.color, 0xF1C40F);
    assert.match(embed.description, /\*\*TurtleGang\*\* — 100,898/);
    assert.match(embed.description, /\*\*RastaMouse\*\* — 73,376 \(-1,004\)/);
    assert.equal(embed.footer.text, 'captunnel');

    // No outbound state is even created — the board never touches the Minecraft path.
    assert.deepEqual(sent.concat(wb.users.get(USER)?.queue ?? []), [],
      'ten lines of board must never be echoed into chat');
  } finally { wb.stopAll(); }
});

test('the leaderboard falls back to the wall webhook, and stays quiet with no entries', async () => {
  clearWallTables();
  db.updateSettings(USER, {
    wall_to_discord: 1, wall_discord_webhook: 'https://discord.test/wall',
    leaderboard_to_discord: 0, leaderboard_discord_webhook: '',
  });
  const session = { account: { id: 'a', username: 'captunnel' }, bot: { username: 'captunnel' }, status: 'online', sendChat() {} };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  try {
    let posts = await capturePost(async () => {
      wb.postLeaderboard(USER, [{ rank: 1, name: 'TurtleGang', points: 1, gain: null }]);
    });
    assert.equal(posts[0].url, 'https://discord.test/wall');

    posts = await capturePost(async () => { wb.postLeaderboard(USER, []); });
    assert.equal(posts.length, 0, 'an empty board is not worth a post');
  } finally { wb.stopAll(); }
});

// ---- quiet hours ----

// A window that definitely contains "now", and one that definitely doesn't, built from the
// current local hour so these don't depend on when the suite runs.
function quietWindows() {
  const h = new Date().getHours();
  const pad = (n) => String((n + 24) % 24).padStart(2, '0');
  return {
    inside: { start: `${pad(h - 1)}:00`, end: `${pad(h + 2)}:00` },
    outside: { start: `${pad(h + 3)}:00`, end: `${pad(h + 5)}:00` },
  };
}

test('an in-game check is refused during quiet hours', () => {
  clearWallTables();
  const { inside } = quietWindows();
  const { wb, session } = harness({
    wall_require_verified: 0,
    wall_quiet_start: inside.start, wall_quiet_end: inside.end,
  });
  try {
    wb.handleChat(USER, session, 'Notch: check');
    assert.deepEqual(db.allWallCheckers.all(USER), [], 'nothing may be banked during quiet hours');
  } finally { wb.stopAll(); }
});

test('the same check counts once quiet hours are over', () => {
  clearWallTables();
  const { outside } = quietWindows();
  const { wb, session } = harness({
    wall_require_verified: 0,
    wall_quiet_start: outside.start, wall_quiet_end: outside.end,
  });
  try {
    wb.handleChat(USER, session, 'Notch: check');
    assert.equal(db.allWallCheckers.all(USER).find((r) => r.player === 'notch').checks, 1);
  } finally { wb.stopAll(); }
});

test('the panel button overrides quiet hours', () => {
  clearWallTables();
  const { inside } = quietWindows();
  const { wb } = harness({
    wall_require_verified: 0,
    wall_quiet_start: inside.start, wall_quiet_end: inside.end,
  });
  try {
    wb.manualCheck(USER, 'panel');
    assert.equal(db.allWallCheckers.all(USER).find((r) => r.player === 'panel').checks, 1,
      'the operator can still record a check by hand');
  } finally { wb.stopAll(); }
});

test('the unchecked count restarts when quiet hours lift', () => {
  clearWallTables();
  const sent = [];
  const { inside, outside } = quietWindows();
  db.updateSettings(USER, {
    wall_enabled: 1, wall_to_minecraft: 1, wall_to_discord: 0,
    wall_interval_ms: 30000,
    wall_reminder_message: '{minutes}',
    wall_quiet_start: inside.start, wall_quiet_end: inside.end,
  });
  const session = { account: { id: 'a', username: 'bot' }, bot: { username: 'bot' }, status: 'online', sendChat: (m) => sent.push(m) };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  const drain = () => {
    const out = wb.users.get(USER).queue.concat(sent);
    wb.users.get(USER).queue.length = 0; sent.length = 0;
    return out;
  };
  try {
    const state = wb._stateFor(USER);
    state.wallActive = true;
    state.lastCheckAt = Date.now() - 17 * 60 * 60 * 1000; // unchecked overnight

    wb._tick();
    assert.deepEqual(drain(), [], 'silent inside the window');
    assert.equal(state.wasQuiet, true);

    // Quiet hours end.
    db.updateSettings(USER, { wall_quiet_start: outside.start, wall_quiet_end: outside.end });
    wb._tick();
    assert.deepEqual(drain(), [], 'the count restarts, so nothing is due yet');
    assert.ok(state.quietEndedAt > 0, 'the restart point is recorded');

    // A full interval later, the reminder measures from the end of quiet hours, not 17h ago.
    state.quietEndedAt = Date.now() - 31 * 1000;
    wb._tick();
    assert.deepEqual(drain(), ['1'], 'about a minute, not 1020');

    // And the real record of when someone last checked is untouched.
    assert.ok(Date.now() - state.lastCheckAt > 16 * 60 * 60 * 1000,
      'lastCheckAt still reflects the genuine last check');
  } finally { wb.stopAll(); }
});

// ---- raid alert embed ----

function raidHarness(overrides = {}) {
  db.updateSettings(USER, {
    wall_enabled: 1, raid_enabled: 1, wall_to_minecraft: 0,
    wall_to_discord: 0,
    raid_to_discord: 1, raid_discord_webhook: 'https://discord.test/raid',
    raid_message: 'RAID ALERT - DEFEND THE BASE',
    raid_discord_message: 'Check walls immediately and get online.',
    raid_delay_ms: 3000,
    ...overrides,
  });
  const session = { account: { id: 'a', username: 'captunnel' }, bot: { username: 'captunnel' }, status: 'online', sendChat() {} };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  return { wb, session };
}

test('a raid alert posts a TNT embed with the headline and elapsed time', async () => {
  clearWallTables();
  const { wb } = raidHarness();
  try {
    const posts = await capturePost(async () => {
      wb._beginRaid(USER, db.getSettings.get(USER), null);
    });

    assert.equal(posts.length, 1);
    assert.equal(posts[0].url, 'https://discord.test/raid');

    const embed = posts[0].body.embeds[0];
    assert.equal(embed.author.name, 'WE ARE GETTING RAIDED!');
    assert.match(embed.author.icon_url, /MHF_TNT/, 'TNT block icon');
    assert.equal(embed.description, '**Check walls immediately and get online.**');
    assert.equal(embed.color, 0xED4245);
    assert.equal(embed.footer.text, 'captunnel');

    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.match(byName['Alert started'], /^`\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}`$/);
    assert.equal(byName['Time since alert'], '`0s`');
    assert.equal(byName['Time since last check'], undefined, 'that field belongs to check logs');
  } finally { wb.stopAll(); }
});

test('time since alert climbs on each repeat instead of freezing', async () => {
  clearWallTables();
  const { wb } = raidHarness();
  try {
    const posts = await capturePost(async () => {
      wb._beginRaid(USER, db.getSettings.get(USER), null);
      // Age the alert, then fire the repeat the interval would have fired.
      wb._stateFor(USER).raidStartedAt = Date.now() - 95 * 1000;
      wb._sendRaidAlert(USER);
    });

    const elapsed = posts.map((p) => Object.fromEntries(
      p.body.embeds[0].fields.map((f) => [f.name, f.value]),
    )['Time since alert']);
    assert.deepEqual(elapsed, ['`0s`', '`1m 35s`']);
  } finally { wb.stopAll(); }
});

test('clearing a raid reports how long it lasted', async () => {
  clearWallTables();
  const { wb } = raidHarness();
  try {
    wb._beginRaid(USER, db.getSettings.get(USER), null);
    wb._stateFor(USER).raidStartedAt = Date.now() - 42 * 1000;

    const posts = await capturePost(async () => { wb._endRaid(USER, null); });
    const embed = posts[0].body.embeds[0];
    assert.equal(embed.color, 0x99AAB5);
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.equal(byName['Alert lasted'], '`42s`');
    assert.equal(wb._stateFor(USER).raidStartedAt, 0, 'the clock resets for the next raid');
  } finally { wb.stopAll(); }
});

test('wall reminders pause while a raid runs and resume once cleared', () => {
  clearWallTables();
  const sent = [];
  db.updateSettings(USER, {
    wall_enabled: 1, raid_enabled: 1,
    wall_to_minecraft: 1, wall_to_discord: 0, raid_to_discord: 0,
    wall_interval_ms: 30000, wall_quiet_start: '', wall_quiet_end: '',
    wall_reminder_message: 'REMINDER',
  });
  const session = { account: { id: 'a', username: 'captunnel' }, bot: { username: 'captunnel' }, status: 'online', sendChat: (m) => sent.push(m) };
  const wb = new WallBot({ emitToUser() {}, resolveSession: () => session });
  const drain = () => {
    const out = wb.users.get(USER).queue.concat(sent);
    wb.users.get(USER).queue.length = 0; sent.length = 0;
    return out.filter((l) => l === 'REMINDER');
  };
  try {
    const state = wb._stateFor(USER);
    state.wallActive = true;
    state.lastCheckAt = Date.now() - 60 * 60 * 1000;

    wb._beginRaid(USER, db.getSettings.get(USER), null);
    drain();
    wb._tick();
    assert.deepEqual(drain(), [], 'no wall reminder while the raid is up');

    wb._endRaid(USER, null);
    drain();
    wb._tick();
    assert.deepEqual(drain(), ['REMINDER'], 'reminders resume once the raid is cleared');
  } finally { wb.stopAll(); }
});

// ---- duration / clock formatting ----

test('formatDuration drops leading zero units', () => {
  assert.equal(formatDuration(((6 * 3600) + (59 * 60) + 26) * 1000), '6h 59m 26s');
  assert.equal(formatDuration((5 * 60 + 3) * 1000), '5m 3s');
  assert.equal(formatDuration(9000), '9s');
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(-500), '0s', 'a negative gap must not render as nonsense');
});

test('formatClock renders zero-padded local time', () => {
  assert.equal(formatClock(new Date(2026, 6, 14, 14, 45, 37)), '2026/07/14 14:45:37');
  assert.equal(formatClock(new Date(2026, 0, 5, 9, 8, 7)), '2026/01/05 09:08:07');
});

// ---- password redaction in the console ----

test('the verify password is redacted from console output', async () => {
  const { default: BotSession } = await import('../server/bots/BotSession.js');
  const mk = (password) => new BotSession({
    userId: USER,
    account: { id: 'a', username: 'wallbot', auth_type: 'offline' },
    settings: { wall_verify_password: password },
    emit() {},
  });

  const line = '[captunnel] [alienplanet] [wzul -> me] verify turtles';
  assert.equal(mk('turtles')._redact(line),
    '[captunnel] [alienplanet] [wzul -> me] verify ***');
  // Every occurrence, not just the first.
  assert.equal(mk('turtles')._redact('turtles and turtles'), '*** and ***');
  // No password configured: nothing to hide, line passes through untouched.
  assert.equal(mk('')._redact(line), line);
  // A password containing regex metacharacters must not blow up or mangle the line.
  assert.equal(mk('a.*b')._redact('say a.*b now'), 'say *** now');
  assert.equal(mk('a.*b')._redact('say aXXb now'), 'say aXXb now');
});

test('normalizePlayer folds casing so one player cannot occupy two rows', () => {
  assert.equal(normalizePlayer('  NoTcH '), 'notch');
  assert.equal(normalizePlayer(null), '');
});
