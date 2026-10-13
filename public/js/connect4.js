// Pure Connect Four logic, shared by the browser and the server.
// The board is a flat array of ROWS * COLS cells, row 0 at the top: 0 empty, 1 red, 2 yellow.

export const ROWS = 6;
export const COLS = 7;
export const EMPTY = 0;
export const RED = 1;
export const YELLOW = 2;
export const LEVELS = ['easy', 'normal', 'hard'];

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
const ORDER = [3, 2, 4, 1, 5, 0, 6]; // center first: better moves earlier, more pruning
const WIN = 1e6;

export const emptyBoard = () => Array(ROWS * COLS).fill(EMPTY);
export const other = p => 3 - p;
export const isFull = b => b.slice(0, COLS).every(Boolean);
export const validCols = b => [...Array(COLS).keys()].filter(c => !b[c]);

/** Row a disc dropped into column c lands on, or -1 if the column is full or invalid. */
export function dropRow(b, c) {
  if (!Number.isInteger(c) || c < 0 || c >= COLS) return -1;
  for (let r = ROWS - 1; r >= 0; r--) if (!b[r * COLS + c]) return r;
  return -1;
}

/** Drop a disc for player p into column c; returns the row or -1. */
export function play(b, c, p) {
  const r = dropRow(b, c);
  if (r >= 0) b[r * COLS + c] = p;
  return r;
}

const own = (b, r, c, p) => r >= 0 && r < ROWS && c >= 0 && c < COLS && b[r * COLS + c] === p;

/** All cells in four-or-more lines through (r, c), as [[r, c], …], or null if none. */
export function winAt(b, r, c) {
  const p = b[r * COLS + c];
  if (!p) return null;
  const cells = [];
  for (const [dr, dc] of DIRS) {
    const line = [[r, c]];
    for (const s of [1, -1]) {
      for (let k = 1; own(b, r + dr * k * s, c + dc * k * s, p); k++) line.push([r + dr * k * s, c + dc * k * s]);
    }
    if (line.length >= 4) cells.push(...line.filter(([lr, lc]) => !cells.some(([x, y]) => x === lr && y === lc)));
  }
  return cells.length ? cells : null;
}

function wins(b, r, c, p) {
  for (const [dr, dc] of DIRS) {
    let n = 1;
    for (let k = 1; own(b, r + dr * k, c + dc * k, p); k++) n++;
    for (let k = 1; own(b, r - dr * k, c - dc * k, p); k++) n++;
    if (n >= 4) return true;
  }
  return false;
}

// ── Computer opponent ──

// Every horizontal, vertical and diagonal window of four cells.
const WINDOWS = [];
for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    for (const [dr, dc] of DIRS) {
      const er = r + dr * 3;
      const ec = c + dc * 3;
      if (er < 0 || er >= ROWS || ec < 0 || ec >= COLS) continue;
      WINDOWS.push([0, 1, 2, 3].map(k => (r + dr * k) * COLS + c + dc * k));
    }
  }
}
const WEIGHT = [0, 1, 4, 16]; // value of a window holding 1, 2 or 3 of one colour and nothing else

/** Static score of a position from p's point of view. */
function evaluate(b, p) {
  const o = other(p);
  let s = 0;
  for (let r = 0; r < ROWS; r++) {
    const v = b[r * COLS + 3];
    if (v === p) s += 3;
    else if (v === o) s -= 3;
  }
  for (const w of WINDOWS) {
    let mine = 0;
    let theirs = 0;
    for (const i of w) {
      if (b[i] === p) mine++;
      else if (b[i] === o) theirs++;
    }
    if (!theirs) s += WEIGHT[mine] ?? 0;
    else if (!mine) s -= WEIGHT[theirs] ?? 0;
  }
  return s;
}

function topsOf(b) {
  return Array.from({ length: COLS }, (_, c) => dropRow(b, c));
}

function negamax(b, tops, depth, alpha, beta, p, filled) {
  if (filled === ROWS * COLS) return 0;
  for (const c of ORDER) {
    const r = tops[c];
    if (r >= 0 && wins(b, r, c, p)) return WIN - filled;
  }
  if (depth === 0) return evaluate(b, p);
  let best = -Infinity;
  for (const c of ORDER) {
    const r = tops[c];
    if (r < 0) continue;
    b[r * COLS + c] = p;
    tops[c]--;
    const v = -negamax(b, tops, depth - 1, -beta, -alpha, other(p), filled + 1);
    tops[c]++;
    b[r * COLS + c] = EMPTY;
    if (v > best) best = v;
    if (v > alpha) alpha = v;
    if (alpha >= beta) break;
  }
  return best;
}

/** Score every legal column for player p with a depth-limited search. */
export function scoreMoves(board, p, depth) {
  const b = board.slice();
  const tops = topsOf(b);
  const filled = b.filter(Boolean).length;
  const out = [];
  for (const c of ORDER) {
    const r = tops[c];
    if (r < 0) continue;
    b[r * COLS + c] = p;
    let v;
    if (wins(b, r, c, p)) v = WIN - filled;
    else {
      tops[c]--;
      v = -negamax(b, tops, depth - 1, -Infinity, Infinity, other(p), filled + 1);
      tops[c]++;
    }
    b[r * COLS + c] = EMPTY;
    out.push({ c, v });
  }
  return out;
}

const SEARCH_DEPTH = { normal: 4, hard: 8 };

/** Column the computer plays for p at the given level. */
export function aiMove(board, p, level = 'normal', rng = Math.random) {
  const cols = validCols(board);
  if (!cols.length) return -1;
  const pick = list => list[Math.floor(rng() * list.length)];
  const finds = q => cols.filter(c => {
    const b = board.slice();
    const r = play(b, c, q);
    return wins(b, r, c, q);
  });

  if (level === 'easy') {
    const win = finds(p);
    if (win.length) return pick(win);
    const block = finds(other(p));
    if (block.length && rng() < 0.6) return pick(block);
    // Lean towards the middle, like a casual player would.
    return pick(cols.flatMap(c => Array(4 - Math.abs(c - 3)).fill(c)));
  }

  const scored = scoreMoves(board, p, SEARCH_DEPTH[level] ?? SEARCH_DEPTH.normal);
  const best = Math.max(...scored.map(m => m.v));
  return pick(scored.filter(m => m.v === best).map(m => m.c));
}

/** Seeded PRNG for reproducible tests. */
export function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
