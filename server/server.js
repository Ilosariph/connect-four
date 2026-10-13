// HTTP static server + WebSocket endpoint (/ws) for online matches. No dependencies.
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { upgrade } from "./ws.js";
import { newCode, Room } from "./rooms.js";

const PORT = Number(process.env.PORT) || 5000;
const MAX_CLIENTS = Number(process.env.MAX_CLIENTS) || 300;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const ROOM_IDLE_MS = 15 * 60 * 1000; // drop rooms nobody is connected to
const ROOM_MAX_MS = 6 * 60 * 60 * 1000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

const server = http.createServer(async (req, res) => {
  const base = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  };
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400, base).end();
    return;
  }
  if (pathname === "/healthz") {
    res.writeHead(200, { ...base, "Content-Type": "text/plain" }).end("ok");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { ...base, Allow: "GET, HEAD" }).end();
    return;
  }
  if (pathname.endsWith("/")) pathname += "index.html";
  const file = path.join(PUBLIC, path.normalize(pathname));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403, base).end();
    return;
  }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      ...base,
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      // Revalidate so new deployments are picked up immediately.
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    res.writeHead(404, { ...base, "Content-Type": "text/plain" }).end("not found");
  }
});

// ── Rooms ──

const rooms = new Map(); // code → Room
const clients = new Set();
let waiting = null; // quick-match room with one player

const cleanName = (n) =>
  String(n ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .slice(0, 16) || "Player";

const send = (client, msg) => client.ws.send(JSON.stringify(msg));

function broadcast(room) {
  room.touched = Date.now();
  room.seats.forEach((s, i) => {
    if (s.conn) send(s.conn, room.stateFor(i));
  });
}

function detach(client) {
  const { room, seat } = client;
  if (!room) return;
  if (room.seats[seat]?.conn === client) room.seats[seat].conn = null;
  client.room = null;
  broadcast(room);
}

function seatClient(client, room, seat) {
  detach(client);
  const s = room.seats[seat];
  if (s.conn && s.conn !== client) {
    // Same player opened the room again elsewhere: the newest connection wins.
    send(s.conn, { t: "error", msg: "This game was opened in another tab.", fatal: true });
    s.conn.room = null;
  }
  s.conn = client;
  client.room = room;
  client.seat = seat;
  send(client, { t: "room", code: room.code, token: s.token });
  broadcast(room);
}

function createRoom(opts = {}) {
  if (rooms.size >= MAX_ROOMS) return null;
  const room = new Room(newCode(rooms), opts);
  rooms.set(room.code, room);
  return room;
}

function handle(client, m) {
  const room = client.room;
  switch (m.t) {
    case "create": {
      const r = createRoom();
      if (!r) return send(client, { t: "error", msg: "Server is full, try again later." });
      seatClient(client, r, r.addPlayer(cleanName(m.name)));
      return;
    }
    case "quick": {
      if (waiting && (waiting.full || waiting.closed || !waiting.seats[0].conn || waiting.seats[0].conn === client)) waiting = null;
      if (waiting) {
        const r = waiting;
        waiting = null;
        seatClient(client, r, r.addPlayer(cleanName(m.name)));
        return;
      }
      const r = createRoom({ quick: true });
      if (!r) return send(client, { t: "error", msg: "Server is full, try again later." });
      waiting = r;
      seatClient(client, r, r.addPlayer(cleanName(m.name)));
      return;
    }
    case "join": {
      const r = rooms.get(String(m.code ?? "").toUpperCase());
      if (!r) return send(client, { t: "error", msg: "Room not found.", gone: true });
      const seat = typeof m.token === "string" ? r.seatOf(m.token) : -1;
      if (seat >= 0) return seatClient(client, r, seat);
      const added = r.addPlayer(cleanName(m.name));
      if (added < 0) return send(client, { t: "error", msg: r.closed ? "That game has ended." : "Room is full.", gone: true });
      seatClient(client, r, added);
      return;
    }
    case "leave": {
      if (!room) return;
      room.leave(client.seat);
      if (waiting === room) waiting = null;
      detach(client);
      return;
    }
  }
  if (!room) return;
  const i = client.seat;
  if (m.t === "drop") {
    if (!room.drop(i, m.c)) return;
  } else if (m.t === "rematch") {
    room.rematch(i);
  } else {
    return;
  }
  broadcast(room);
}

server.on("upgrade", (req, sock, head) => {
  if (!req.url.startsWith("/ws") || clients.size >= MAX_CLIENTS) {
    sock.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    return;
  }
  const ws = upgrade(req, sock, head);
  if (!ws) return;

  const client = { ws, room: null, seat: -1, msgs: 0 };
  clients.add(client);

  ws.on("message", (raw) => {
    if (++client.msgs > 30) return ws.destroy(); // per-second budget, reset below
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m && typeof m === "object") handle(client, m);
  });

  ws.on("close", () => {
    clients.delete(client);
    detach(client);
  });
});

setInterval(() => {
  for (const c of clients) c.msgs = 0;
}, 1000);

setInterval(() => {
  for (const c of clients) {
    if (!c.ws.alive) {
      c.ws.destroy();
      continue;
    }
    c.ws.alive = false;
    c.ws.ping();
  }
  const now = Date.now();
  for (const [code, r] of rooms) {
    const idle = r.seats.every((s) => !s.conn) && now - r.touched > ROOM_IDLE_MS;
    if (idle || now - r.touched > ROOM_MAX_MS) {
      rooms.delete(code);
      if (waiting === r) waiting = null;
    }
  }
}, 25000);

server.listen(PORT, () => console.log(`connect-four listening on :${PORT}`));

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));
