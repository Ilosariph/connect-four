// Online match state. The server owns the board and validates every move.
import crypto from "node:crypto";
import { emptyBoard, isFull, play, RED, winAt, YELLOW } from "../public/js/connect4.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PIECES = [RED, YELLOW]; // seat 0 is always red, seat 1 yellow

export function newCode(taken, rng = Math.random) {
  for (;;) {
    let code = "";
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(rng() * CODE_CHARS.length)];
    if (!taken.has(code)) return code;
  }
}

export class Room {
  constructor(code, { quick = false, rng = Math.random } = {}) {
    this.code = code;
    this.quick = quick;
    this.rng = rng;
    this.seats = []; // { token, name, conn, rematch, left }
    this.phase = "wait"; // wait | play | over
    this.board = emptyBoard();
    this.starter = -1;
    this.turn = 0;
    this.winner = -1; // seat, or 2 for a draw
    this.win = null;
    this.last = null;
    this.moves = 0;
    this.closed = false; // someone left; the room can't continue
    this.touched = Date.now();
  }

  get full() {
    return this.seats.length === 2;
  }

  seatOf(token) {
    return this.seats.findIndex((s) => s.token === token);
  }

  addPlayer(name) {
    if (this.full || this.closed) return -1;
    this.seats.push({ token: crypto.randomUUID(), name, conn: null, rematch: false, left: false });
    if (this.full) this.#start(this.rng() < 0.5 ? 0 : 1);
    return this.seats.length - 1;
  }

  #start(starter) {
    Object.assign(this, { phase: "play", board: emptyBoard(), starter, turn: starter, winner: -1, win: null, last: null, moves: 0 });
    for (const s of this.seats) s.rematch = false;
  }

  /** Seat i drops a disc into column col. Returns true if the move was played. */
  drop(i, col) {
    if (this.phase !== "play" || this.closed || this.turn !== i) return false;
    const r = play(this.board, col, PIECES[i]);
    if (r < 0) return false;
    this.moves++;
    this.last = { r, c: col, piece: PIECES[i] };
    this.win = winAt(this.board, r, col);
    if (this.win) {
      this.phase = "over";
      this.winner = i;
    } else if (isFull(this.board)) {
      this.phase = "over";
      this.winner = 2;
    } else {
      this.turn = 1 - i;
    }
    return true;
  }

  /** Both players asked for a rematch: the other player starts. */
  rematch(i) {
    if (this.phase !== "over" || this.closed) return;
    this.seats[i].rematch = true;
    if (this.seats.every((s) => s.rematch)) this.#start(1 - this.starter);
  }

  /** A player left for good: the opponent wins a running game. */
  leave(i) {
    if (this.phase === "play") {
      this.phase = "over";
      this.winner = 1 - i;
    }
    this.seats[i].left = true;
    this.closed = true;
  }

  stateFor(i) {
    const me = this.seats[i];
    const opp = this.seats[1 - i];
    const over = this.phase === "over";
    return {
      t: "state",
      code: this.code,
      phase: this.phase,
      closed: this.closed,
      board: this.board,
      myPiece: PIECES[i],
      myTurn: this.phase === "play" && this.turn === i,
      iStarted: this.starter === i,
      last: this.last,
      win: this.win,
      moves: this.moves,
      winner: over ? (this.winner === 2 ? "draw" : this.winner === i ? "me" : "opp") : null,
      me: { name: me.name, rematch: me.rematch },
      opp: opp ? { name: opp.name, connected: !!opp.conn, left: opp.left, rematch: opp.rematch } : null,
    };
  }
}
