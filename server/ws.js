// Minimal RFC 6455 WebSocket server side (text frames only, no extensions).
// Enough for small JSON game messages without pulling in a dependency.
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_PAYLOAD = 4096;

export class Socket extends EventEmitter {
  constructor(sock, head) {
    super();
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.open = true;
    this.alive = true;
    sock.setNoDelay(true);
    sock.on("data", (d) => this.#onData(d));
    sock.on("close", () => this.#closed());
    sock.on("error", () => this.#closed());
    if (head?.length) this.#onData(head);
  }

  get buffered() {
    return this.sock.writableLength;
  }

  send(str) {
    if (this.open) this.sock.write(frame(0x1, Buffer.from(str)));
  }

  ping() {
    if (this.open) this.sock.write(frame(0x9, Buffer.alloc(0)));
  }

  close() {
    if (!this.open) return;
    this.sock.end(frame(0x8, Buffer.alloc(0)));
    this.#closed();
  }

  destroy() {
    this.sock.destroy();
    this.#closed();
  }

  #closed() {
    if (!this.open) return;
    this.open = false;
    this.emit("close");
  }

  #onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.open) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        if (buf.readUInt32BE(2) !== 0) return this.destroy();
        len = buf.readUInt32BE(6);
        off = 10;
      }
      // Clients must mask; we never expect fragmented or large messages.
      if (!masked || !fin || len > MAX_PAYLOAD) return this.destroy();
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = buf.subarray(off + 4 + len);

      switch (op) {
        case 0x1: this.emit("message", payload.toString("utf8")); break;
        case 0x2: break; // binary: ignored
        case 0x8: this.close(); return;
        case 0x9: this.sock.write(frame(0xa, payload)); break;
        case 0xa: this.alive = true; break;
        default: return this.destroy();
      }
    }
  }
}

function frame(op, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | op, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | op;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | op;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  return Buffer.concat([header, payload]);
}

/** Complete the HTTP upgrade handshake; returns a Socket or null. */
export function upgrade(req, sock, head) {
  const key = req.headers["sec-websocket-key"];
  if ((req.headers.upgrade || "").toLowerCase() !== "websocket" || !key) {
    sock.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  sock.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  return new Socket(sock, head);
}
