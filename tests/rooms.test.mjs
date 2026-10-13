import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { newCode, Room } from '../server/rooms.js';

function startedRoom() {
  const room = new Room('TEST', { rng: () => 0 }); // rng 0 → seat 0 starts
  room.addPlayer('a');
  assert.equal(room.phase, 'wait');
  room.addPlayer('b');
  assert.equal(room.phase, 'play');
  return room;
}

test('newCode avoids taken codes', () => {
  const taken = new Set(['AAAA']);
  let n = 0;
  const rng = () => (n++ < 4 ? 0 : 0.5);
  const code = newCode(taken, rng);
  assert.equal(code.length, 4);
  assert.notEqual(code, 'AAAA');
});

test('only the player on turn can drop, into valid columns', () => {
  const room = startedRoom();
  assert.equal(room.drop(1, 0), false);
  assert.equal(room.drop(0, 7), false);
  assert.equal(room.drop(0, -1), false);
  assert.equal(room.drop(0, '3'), false);
  assert.equal(room.drop(0, 3), true);
  assert.equal(room.drop(0, 3), false);
  assert.equal(room.drop(1, 3), true);
  const s = room.stateFor(0);
  assert.equal(s.myTurn, true);
  assert.equal(s.myPiece, 1);
  assert.deepEqual(s.last, { r: 4, c: 3, piece: 2 });
  assert.equal(room.stateFor(1).myTurn, false);
});

test('four in a row wins and rematch swaps who starts', () => {
  const room = startedRoom();
  for (const [seat, c] of [[0, 0], [1, 6], [0, 1], [1, 6], [0, 2], [1, 6], [0, 3]]) assert.ok(room.drop(seat, c));
  assert.equal(room.phase, 'over');
  assert.equal(room.stateFor(0).winner, 'me');
  assert.equal(room.stateFor(1).winner, 'opp');
  assert.equal(room.stateFor(0).win.length, 4);
  assert.equal(room.drop(1, 5), false);

  room.rematch(0);
  assert.equal(room.phase, 'over');
  assert.equal(room.stateFor(1).opp.rematch, true);
  room.rematch(1);
  assert.equal(room.phase, 'play');
  assert.equal(room.moves, 0);
  assert.equal(room.stateFor(1).myTurn, true);
  assert.ok(room.board.every((v) => v === 0));
});

test('a full board without a line is a draw', () => {
  const room = startedRoom();
  // Columns filled in pairs so no four line up: pattern repeats every two rows.
  const order = [0, 1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 2, 3, 2, 3, 2, 3, 3, 2, 3, 2, 3, 2, 4, 5, 4, 5, 4, 5, 5, 4, 5, 4, 5, 4, 6, 6, 6, 6, 6, 6];
  order.forEach((c, i) => assert.ok(room.drop(i % 2, c), `move ${i} in column ${c}`));
  assert.equal(room.phase, 'over');
  assert.equal(room.stateFor(0).winner, 'draw');
  assert.equal(room.win, null);
});

test('leaving mid-game hands the win to the opponent', () => {
  const room = startedRoom();
  room.drop(0, 3);
  room.leave(0);
  assert.equal(room.phase, 'over');
  assert.equal(room.stateFor(1).winner, 'me');
  assert.equal(room.stateFor(1).opp.left, true);
  assert.ok(room.closed);
  room.rematch(1);
  assert.equal(room.phase, 'over');
});

test('rooms take two players at most', () => {
  const room = startedRoom();
  assert.equal(room.addPlayer('c'), -1);
});

// ── End to end over a real WebSocket ──

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const queue = [];
  const waiters = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    const w = waiters.findIndex(x => x.pred(m));
    if (w >= 0) {
      queue.length = 0; // anything older is stale
      waiters.splice(w, 1)[0].resolve(m);
    }
    else queue.push(m);
  };
  return {
    ws,
    open: new Promise(res => { ws.onopen = res; }),
    send: m => ws.send(JSON.stringify(m)),
    next(pred) {
      const i = queue.findIndex(pred);
      if (i >= 0) return Promise.resolve(queue.splice(0, i + 1)[i]); // drop older messages
      return new Promise(resolve => waiters.push({ pred, resolve }));
    },
  };
}

test('two players play a full online game', async t => {
  const port = 5600 + Math.floor(Math.random() * 300);
  const srv = spawn(process.execPath, ['server/server.js'], { env: { ...process.env, PORT: port }, stdio: 'pipe' });
  t.after(() => srv.kill());
  await new Promise(res => srv.stdout.once('data', res));

  const a = client(port);
  const b = client(port);
  t.after(() => { a.ws.close(); b.ws.close(); });
  await Promise.all([a.open, b.open]);
  a.send({ t: 'create', name: 'Alice' });
  const { code, token } = await a.next(m => m.t === 'room');
  b.send({ t: 'join', code, name: 'Bob' });
  await b.next(m => m.t === 'room');

  let sa = await a.next(m => m.t === 'state' && m.phase === 'play');
  let sb = await b.next(m => m.t === 'state' && m.phase === 'play');
  assert.equal(sa.opp.name, 'Bob');
  assert.notEqual(sa.myTurn, sb.myTurn);

  // Alice builds a row along the bottom, Bob stacks on the right without lining up four.
  const aCols = [0, 1, 2, 3, 4];
  const bCols = [6, 6, 6, 5, 5, 5];
  for (let n = 0; n < 12 && sa.phase === 'play'; n++) {
    if (sa.myTurn) a.send({ t: 'drop', c: aCols.shift() });
    else b.send({ t: 'drop', c: bCols.shift() });
    sa = await a.next(m => m.t === 'state');
    sb = await b.next(m => m.t === 'state');
  }
  assert.equal(sa.phase, 'over');
  assert.equal(sa.winner, 'me');
  assert.equal(sb.winner, 'opp');

  // Reconnect with the token gets the same seat back.
  a.ws.close();
  const a2 = client(port);
  t.after(() => a2.ws.close());
  await a2.open;
  a2.send({ t: 'join', code, token });
  await a2.next(m => m.t === 'room');
  const back = await a2.next(m => m.t === 'state');
  assert.equal(back.me.name, 'Alice');
  assert.equal(back.phase, 'over');
});
