# Connect Four

Ad-free Connect Four in the browser. Play the computer (Easy / Normal / Hard), a friend on the same device, or a friend online.

A small Node server (no npm dependencies) serves `public/` and runs online matches over a WebSocket at `/ws`. Games against the computer and on one device run entirely client-side.

## Features

- **vs Computer**: Easy (takes wins, sometimes blocks, otherwise plays loosely), Normal (4-ply search), Hard (8-ply alpha-beta search). Win/loss/draw record and fastest win per difficulty. Undo takes back your last move and the computer's reply.
- **Two players on this device**: pass and play, with undo.
- **vs Player online**: create a room and share the 4-letter code or invite link, or use *Quick match* to pair with whoever is waiting. The server validates every move. Reloading or a dropped connection rejoins the same seat.
- Who starts alternates between games. Discs drop with a bounce, the winning line is highlighted.
- Keyboard: `←` `→` pick a column, `Enter` / `↓` drop, `1`–`7` drop straight into a column.
- Offline games auto-save to `localStorage`; light/dark theme.

## Run

```sh
docker compose up -d --build   # port 5000 (expects the external `proxy` network)
npm start                      # → http://localhost:5000 (Node >= 20)
```

The reverse proxy in front must forward WebSocket upgrades for `/ws`.

| Env | Default | |
| --- | --- | --- |
| `PORT` | `5000` | HTTP + WebSocket port |
| `MAX_CLIENTS` | `300` | Max concurrent WebSocket connections |
| `MAX_ROOMS` | `500` | Max open rooms |

## Test

```sh
npm test                       # logic, AI and room tests (node --test, no deps)
```

## Layout

| Path | Purpose |
| --- | --- |
| `public/js/connect4.js` | Pure game logic: dropping, win detection, computer opponent (shared with the server) |
| `public/js/main.js` | Menu, board rendering, vs-computer, local and online game flow |
| `server/rooms.js` | Online room state and validation |
| `server/server.js` | Static file server, WebSocket message handling, room cleanup |
| `server/ws.js` | Minimal WebSocket implementation |
| `Dockerfile`, `docker-compose.yml` | Container image and compose file |
