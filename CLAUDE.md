# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running

- `npm start` — Node server at http://localhost:5000 (static files + `/ws`).
- `npm test` — `node --test` (no dependencies).
- `docker compose up --build` — same server in a container on port 5000 (external `proxy` network).

## Architecture

No build step, no npm dependencies. Structure mirrors `../battleships`.

- **`public/js/connect4.js`** — pure logic, imported by both the browser and the server. Board is a flat array of `ROWS * COLS` (row 0 at the top), `0` empty, `1` red, `2` yellow. `play`, `dropRow`, `winAt` (all cells of every line through a cell), `aiMove(board, piece, level)` (easy: heuristics; normal/hard: negamax alpha-beta at depth 4/8).
- **`public/js/main.js`** — all UI. `vm()` turns the local game (`ai` or `local`) or the latest server snapshot into one view model that `render()` draws. `paintBoard()` diffs against the last painted board so only a newly dropped disc animates.
- **`server/rooms.js`** — `Room`: seats with reconnect tokens, phases `wait → play → over`. Seat 0 is red, seat 1 yellow; the starter is random, then alternates on rematch.
- **`server/server.js`** — HTTP + WebSocket, quick-match queue, idle room cleanup. `server/ws.js` is copied from games-landingpage.

**Key design decisions:**
- vs the computer the player is always red; who starts alternates per game (`aiStarter` / `localStarter` in settings).
- Online the server is authoritative; clients send `create`/`quick`/`join`/`drop`/`rematch`/`leave` and receive full `state` snapshots.
- localStorage keys: `c4-settings`, `c4-game` (vs-computer save), `c4-local` (two-player save), `c4-stats`, `c4-online` (room code + seat token), `dark`.
