import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aiMove, COLS, dropRow, emptyBoard, isFull, mulberry32, play, RED, ROWS, validCols, winAt, YELLOW } from '../public/js/connect4.js';

const board = (moves, first = RED) => {
  const b = emptyBoard();
  let p = first;
  for (const c of moves) {
    play(b, c, p);
    p = 3 - p;
  }
  return b;
};

test('discs stack from the bottom and full columns reject drops', () => {
  const b = emptyBoard();
  for (let i = 0; i < ROWS; i++) assert.equal(play(b, 2, RED), ROWS - 1 - i);
  assert.equal(dropRow(b, 2), -1);
  assert.equal(play(b, 2, RED), -1);
  assert.deepEqual(validCols(b), [0, 1, 3, 4, 5, 6]);
  assert.equal(dropRow(b, 7), -1);
  assert.equal(dropRow(b, 1.5), -1);
  assert.equal(dropRow(b, '3'), -1);
});

test('winAt finds horizontal, vertical and diagonal lines', () => {
  let b = board([0, 0, 1, 1, 2, 2, 3]);
  assert.equal(winAt(b, 5, 3).length, 4);
  b = board([0, 1, 0, 1, 0, 1, 0]);
  assert.deepEqual(winAt(b, 2, 0).map(String).sort(), ['2,0', '3,0', '4,0', '5,0']);
  // Rising diagonal for red: (5,0) (4,1) (3,2) (2,3)
  b = board([0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3]);
  assert.ok(winAt(b, 2, 3));
  assert.equal(winAt(board([0, 1, 2]), 5, 2), null);
});

test('winAt returns every cell when one disc completes two lines', () => {
  const b = emptyBoard();
  for (const c of [0, 1, 2, 4, 5, 6]) b[5 * COLS + c] = RED;
  b[5 * COLS + 3] = RED;
  assert.equal(winAt(b, 5, 3).length, 7);
});

test('isFull', () => {
  const b = emptyBoard();
  assert.equal(isFull(b), false);
  b.fill(YELLOW);
  assert.equal(isFull(b), true);
});

test('every level takes an immediate win', () => {
  const b = board([3, 0, 3, 0, 3, 1]); // red has three in column 3
  for (const level of ['easy', 'normal', 'hard']) assert.equal(aiMove(b, RED, level, mulberry32(1)), 3);
});

test('normal and hard block an immediate threat', () => {
  const b = board([0, 6, 1, 6, 2]); // red threatens column 3
  for (const level of ['normal', 'hard']) assert.equal(aiMove(b, YELLOW, level, mulberry32(2)), 3);
});

test('hard sees a two-way threat coming', () => {
  // Red on (5,1) and (5,2): red at (5,3) makes three with both ends open, a forced win.
  assert.equal(aiMove(board([1, 1, 2, 2]), RED, 'hard', mulberry32(3)), 3);
  // So yellow, to move, has to close that pair off now.
  const y = aiMove(board([1, 6, 2]), YELLOW, 'hard', mulberry32(4));
  assert.ok([0, 3, 4].includes(y), `yellow should cap the open two, got ${y}`);
});

test('hard beats easy', () => {
  let wins = 0;
  for (let g = 0; g < 4; g++) {
    const rng = mulberry32(g);
    const b = emptyBoard();
    let p = g % 2 ? RED : YELLOW;
    for (;;) {
      const c = aiMove(b, p, p === RED ? 'hard' : 'easy', rng);
      const r = play(b, c, p);
      if (winAt(b, r, c)) { if (p === RED) wins++; break; }
      if (isFull(b)) break;
      p = 3 - p;
    }
  }
  assert.equal(wins, 4);
});

test('aiMove returns -1 on a full board', () => {
  assert.equal(aiMove(emptyBoard().fill(RED), YELLOW, 'hard'), -1);
});
