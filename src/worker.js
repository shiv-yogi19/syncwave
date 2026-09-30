// SYNCWAVE Worker: room creation, ICE config, WebSocket routing. Audio never touches the server.
export { Room } from "./room.js";

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function randomCode() {
  const limit = Math.floor(2 ** 32 / 900000) * 900000; // rejection sampling: no modulo bias
  const a = new Uint32Array(1);
  do crypto.getRandomValues(a); while (a[0] >= limit);
  return String(100000 + (a[0] % 900000));
}
function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(24));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const stubFor = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/config") {
      let iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
      try { iceServers = JSON.parse(env.ICE_SERVERS); } catch {}
      return json({ iceServers }); // add TURN entries via the ICE_SERVERS var / secret
    }
    if (url.pathname === "/api/create" && req.method === "POST") {
      for (let i = 0; i < 6; i++) {
        const code = randomCode(), token = randomToken();
        const r = await stubFor(env, code).fetch("https://room/init", { method: "POST", body: JSON.stringify({ code, token }) });
        if (r.status === 200) return json({ code, token });
      }
      return json({ error: "Could not create room" }, 500);
    }
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const code = url.searchParams.get("room") || "";
      if (!/^\d{6}$/.test(code)) return new Response("Bad room code", { status: 400 });
      return stubFor(env, code).fetch(req);
    }
    return env.ASSETS.fetch(req);
  },
};
