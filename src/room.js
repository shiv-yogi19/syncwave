// Durable Object: one instance per room code. In-memory only (no storage bindings).
const MAX_LISTENERS = 50, MAX_MSG = 16384, GRACE_MS = 45000;
const ACTIONS = new Set(["play", "pause", "seek", "volume", "song", "stop"]);
const num = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const str = (v) => (typeof v === "string" ? v.slice(0, 200) : "");
function safeEq(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export class Room {
  constructor() {
    this.token = null; this.master = null; this.listeners = new Map(); this.grace = null;
    this.s = null;
  }
  fresh(code) {
    const now = Date.now();
    this.s = { roomCode: code, masterId: "master", songName: "", fileName: "", duration: 0, isPlaying: false, masterPosition: 0, volume: 1, roomStatus: "open", createdAt: now, lastStateUpdate: now };
  }
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/init") {
      if (this.token) return new Response("taken", { status: 409 });
      const b = await req.json();
      this.token = b.token; this.fresh(b.code);
      setTimeout(() => { if (!this.master && !this.listeners.size) this.token = null; }, 120000); // never claimed
      return new Response("ok");
    }
    if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    this.join(server, u.searchParams);
    return new Response(null, { status: 101, webSocket: client });
  }
  join(ws, p) {
    const role = p.get("role");
    const send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
    const fail = (code) => { send({ type: "error", code }); try { ws.close(1008); } catch {} };
    if (!this.token) return fail("ROOM_NOT_FOUND");
    let id;
    if (role === "master") {
      if (!safeEq(p.get("token") || "", this.token)) return fail("FORBIDDEN");
      if (this.master) { try { this.master.ws.close(4000); } catch {} }
      clearTimeout(this.grace); id = "master"; this.master = { ws };
      this.bcast({ type: "master-status", online: true });
      send({ type: "welcome", role, id, state: this.s, listeners: [...this.listeners.keys()], serverTime: Date.now() });
    } else if (role === "listener") {
      if (this.listeners.size >= MAX_LISTENERS) return fail("ROOM_FULL");
      id = crypto.randomUUID().slice(0, 8);
      this.listeners.set(id, ws);
      send({ type: "welcome", role, id, state: this.s, masterOnline: !!this.master, serverTime: Date.now() });
      this.toMaster({ type: "peer-joined", id, n: this.listeners.size });
    } else return fail("BAD_ROLE");

    let n = 0, t = Date.now();
    ws.addEventListener("message", (e) => {
      if (Date.now() - t > 10000) { t = Date.now(); n = 0; }
      if (++n > 300) return ws.close(1008);
      if (typeof e.data !== "string" || e.data.length > MAX_MSG) return;
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m || typeof m.type !== "string") return;
      const isMaster = role === "master" && this.master && this.master.ws === ws;
      switch (m.type) {
        case "ping": return send({ type: "pong", serverTime: Date.now() });
        case "state": {
          if (!isMaster || !ACTIONS.has(m.action)) return;
          if (!num(m.masterPosition, 0, 1e6) || !num(m.duration, 0, 1e6) || !num(m.volume, 0, 2) || typeof m.isPlaying !== "boolean") return;
          Object.assign(this.s, { songName: str(m.songName), fileName: str(m.fileName), duration: m.duration, isPlaying: m.isPlaying, masterPosition: m.masterPosition, volume: m.volume, lastStateUpdate: Date.now() });
          return this.bcast({ type: "state", action: m.action, state: this.s });
        }
        case "signal": {
          const d = m.data;
          if (!d || typeof d !== "object") return;
          const clean = d.sdp && typeof d.sdp === "object" ? { sdp: { type: String(d.sdp.type), sdp: String(d.sdp.sdp) } } : d.candidate && typeof d.candidate === "object" ? { candidate: d.candidate } : null;
          if (!clean) return;
          if (isMaster) { const to = this.listeners.get(String(m.to)); if (to) try { to.send(JSON.stringify({ type: "signal", from: "master", data: clean })); } catch {} }
          else if (role === "listener") this.toMaster({ type: "signal", from: id, data: clean });
          return;
        }
        case "resync": if (role === "listener") this.toMaster({ type: "peer-joined", id, n: this.listeners.size }); return;
        case "close": if (isMaster) this.closeRoom(); return;
      }
    });
    const gone = () => this.left(role, id, ws);
    ws.addEventListener("close", gone); ws.addEventListener("error", gone);
  }
  left(role, id, ws) {
    if (role === "master") {
      if (!this.master || this.master.ws !== ws) return;
      this.master = null; this.bcast({ type: "master-status", online: false });
      this.grace = setTimeout(() => this.closeRoom(), GRACE_MS); // temporary drop != room destroyed
    } else if (this.listeners.get(id) === ws) {
      this.listeners.delete(id);
      this.toMaster({ type: "peer-left", id, n: this.listeners.size });
    }
  }
  toMaster(o) { if (this.master) try { this.master.ws.send(JSON.stringify(o)); } catch {} }
  bcast(o) { const s = JSON.stringify(o); for (const ws of this.listeners.values()) try { ws.send(s); } catch {} }
  closeRoom() {
    clearTimeout(this.grace);
    this.bcast({ type: "room-closed" });
    const all = [...this.listeners.values(), this.master && this.master.ws];
    this.token = null; this.master = null; this.listeners.clear();
    for (const ws of all) try { ws && ws.close(1000); } catch {}
  }
}
