"use strict";
const $ = (s) => document.querySelector(s);
const cfg = { style: "bars", sens: 1, intensity: 1, vis: true, perf: false, lite: false, parts: true };
const S = {};
function resetState() {
  Object.assign(S, { role: null, code: null, token: null, ws: null, id: null, ice: [{ urls: "stun:stun.l.google.com:19302" }], offset: 0,
    room: { songName: "", fileName: "", duration: 0, isPlaying: false, masterPosition: 0, volume: 1, lastStateUpdate: 0 },
    ctx: null, gain: null, analyser: null, dest: null, audio: null, url: null, pcs: new Map(), pc: null, remote: null, vsrc: null,
    retry: 0, closing: false, masterOnline: true, timers: [], dragging: false, resynced: 0, active: false });
}
resetState();

/* ---------- UI helpers ---------- */
let toastT;
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("on"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("on"), 3200); }
function show(id) {
  for (const s of document.querySelectorAll(".scr")) s.hidden = s.id !== id;
  $("#homeBtn").hidden = id === "home";
  $("#code").blur();
}
const fmt = (t) => { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
function setStatus(txt) {
  const el = $("#status"); el.textContent = txt;
  el.className = "pill st " + (txt === "CONNECTED" ? "ok" : txt === "CONNECTION FAILED" ? "bad" : "");
}
function safe(fn) { return (...a) => { try { const r = fn(...a); if (r && r.catch) r.catch((e) => { console.error(e); toast("Something went wrong"); }); } catch (e) { console.error(e); toast("Something went wrong"); } }; }
const ERR = { ROOM_NOT_FOUND: "Room not found", ROOM_FULL: "Room is full", FORBIDDEN: "Could not create room", BAD_ROLE: "Connection failed" };

/* ---------- settings ---------- */
const root = document.documentElement.style;
function bindSettings() {
  const on = (id, f) => $(id).addEventListener("input", safe((e) => f(e.target)));
  on("#sOp", (t) => root.setProperty("--glass-opacity", t.value / 100));
  on("#sBl", (t) => root.setProperty("--glass-blur", t.value + "px"));
  on("#sGl", (t) => root.setProperty("--glass-glow", t.value / 100));
  on("#sBg", (t) => document.body.classList.toggle("noaurora", !t.checked));
  on("#sPa", (t) => { cfg.parts = t.checked; particles(); });
  on("#sSt", (t) => (cfg.style = t.value));
  on("#sSe", (t) => (cfg.sens = t.value / 100));
  on("#sIn", (t) => (cfg.intensity = t.value / 100));
  on("#sVi", (t) => { cfg.vis = t.checked; syncViz(); });
  const lite = () => { cfg.perf = $("#sPf").checked; cfg.lite = $("#sRe").checked || $("#sLo").checked; document.body.classList.toggle("lite", cfg.lite); if ($("#sLo").checked) { cfg.parts = false; $("#sPa").checked = false; } particles(); };
  for (const id of ["#sPf", "#sRe", "#sLo"]) $(id).addEventListener("input", safe(lite));
  $("#setBtn").onclick = () => { const l = S.ctx ? (S.ctx.baseLatency || 0) + (S.ctx.outputLatency || 0) : 0; $("#lat").textContent = l ? Math.round(l * 1000) + " ms" : "n/a"; $("#setDlg").showModal(); };
  $("#setClose").onclick = () => $("#setDlg").close();
}

/* ---------- particles (cheap, stops when hidden/disabled) ---------- */
let pRaf = 0, pts = [];
function particles() {
  const c = $("#parts"), g = c.getContext("2d");
  cancelAnimationFrame(pRaf); pRaf = 0; g.clearRect(0, 0, c.width, c.height);
  if (!cfg.parts || document.hidden) return;
  c.width = innerWidth; c.height = innerHeight;
  if (!pts.length) pts = Array.from({ length: 36 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.8 + .4, v: Math.random() * .00012 + .00003 }));
  const loop = () => {
    pRaf = requestAnimationFrame(loop);
    g.clearRect(0, 0, c.width, c.height); g.fillStyle = "rgba(200,190,255,.5)";
    for (const p of pts) { p.y -= p.v * 16; if (p.y < 0) p.y = 1; g.beginPath(); g.arc(p.x * c.width, p.y * c.height, p.r, 0, 6.3); g.fill(); }
  };
  loop();
}

/* ---------- audio graph ---------- */
function makeCtx() { const AC = window.AudioContext || window.webkitAudioContext; if (!AC) throw new Error("no audio"); S.ctx = new AC(); S.analyser = S.ctx.createAnalyser(); S.analyser.fftSize = 2048; S.analyser.smoothingTimeConstant = .8; }
function initMasterAudio() {
  makeCtx();
  S.audio = new Audio(); S.audio.preload = "auto";
  const src = S.ctx.createMediaElementSource(S.audio);
  S.gain = S.ctx.createGain(); S.dest = S.ctx.createMediaStreamDestination();
  // File -> HTMLAudioElement -> Gain -> Analyser -> WebRTC stream (+ local monitor)
  src.connect(S.gain); S.gain.connect(S.analyser); S.analyser.connect(S.dest); S.analyser.connect(S.ctx.destination);
  S.audio.addEventListener("loadedmetadata", safe(() => { S.room.duration = S.audio.duration || 0; pushState("song"); updateUI(); }));
  S.audio.addEventListener("error", () => { if (S.audio.src) toast("Unsupported audio format"); });
  S.audio.addEventListener("ended", safe(() => { S.room.isPlaying = false; pushState("pause"); updateUI(); }));
}

/* ---------- signaling ---------- */
function send(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  let u = `${proto}://${location.host}/ws?room=${S.code}&role=${S.role}`;
  if (S.role === "master") u += `&token=${encodeURIComponent(S.token)}`;
  const ws = new WebSocket(u); S.ws = ws;
  ws.onopen = () => { S.retry = 0; clearInterval(S.hb); S.hb = setInterval(() => send({ type: "ping" }), 25000); };
  ws.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); toast("Something went wrong"); } };
  ws.onclose = () => {
    if (S.ws !== ws || S.closing) return;
    clearInterval(S.hb); setStatus("RECONNECTING");
    if (++S.retry > 8) { setStatus("CONNECTION FAILED"); toast("Connection lost"); return; }
    setTimeout(() => { if (!S.closing && S.ws === ws) { if (S.role === "listener") closePeer(); connect(); } }, Math.min(1000 * 2 ** S.retry, 10000));
  };
}
async function onMsg(m) {
  switch (m.type) {
    case "welcome":
      S.id = m.id; S.offset = m.serverTime - Date.now(); applyRoom(m.state, "welcome");
      if (S.role === "master") { for (const id of m.listeners) await offer(id); if (S.room.songName || S.audio.src) pushState("song"); setStatus("CONNECTED"); updateCount(m.listeners.length); }
      else { S.masterOnline = m.masterOnline; setStatus("CONNECTING"); updateUI(); }
      break;
    case "error": {
      S.closing = true; const msg = ERR[m.code] || "Connection failed";
      if (S.role === "listener" && m.code !== "FORBIDDEN") { cleanup(); joinScreen(msg); } else { cleanup(); show("home"); toast(msg); }
      break;
    }
    case "peer-joined": updateCount(m.n); await offer(m.id); break;
    case "peer-left": closePeer(m.id); updateCount(m.n); break;
    case "signal": S.role === "master" ? await masterSignal(m.from, m.data) : await listenerSignal(m.data); break;
    case "state": applyRoom(m.state, m.action); break;
    case "master-status": S.masterOnline = m.online; if (!m.online) setStatus("RECONNECTING"); else if (S.pc && S.pc.connectionState === "connected") setStatus("CONNECTED"); updateUI(); break;
    case "room-closed": if (S.role === "listener") endRoom("Room closed", "The Master has ended this room."); break;
  }
}
function updateCount(n) { $("#count").textContent = n + (n === 1 ? " listener" : " listeners"); }

/* ---------- WebRTC: master side (one RTCPeerConnection per listener) ---------- */
async function offer(id) {
  closePeer(id);
  const pc = new RTCPeerConnection({ iceServers: S.ice }); S.pcs.set(id, pc);
  for (const t of S.dest.stream.getAudioTracks()) pc.addTrack(t, S.dest.stream);
  pc.onicecandidate = (e) => { if (e.candidate) send({ type: "signal", to: id, data: { candidate: e.candidate.toJSON() } }); };
  pc.onconnectionstatechange = () => { if (["closed", "failed"].includes(pc.connectionState) && S.pcs.get(id) === pc) { pc.close(); S.pcs.delete(id); } };
  await pc.setLocalDescription(await pc.createOffer());
  send({ type: "signal", to: id, data: { sdp: pc.localDescription.toJSON() } });
}
async function masterSignal(id, d) {
  const pc = S.pcs.get(id); if (!pc) return;
  try { if (d.sdp) await pc.setRemoteDescription(d.sdp); else if (d.candidate) await pc.addIceCandidate(d.candidate); } catch (e) { console.warn("signal", e); }
}
function closePeer(id) {
  if (S.role === "master") { const pc = S.pcs.get(id); if (pc) { pc.onicecandidate = pc.onconnectionstatechange = null; pc.close(); S.pcs.delete(id); } }
  else if (S.pc) { S.pc.onicecandidate = S.pc.onconnectionstatechange = S.pc.ontrack = null; S.pc.close(); S.pc = null; }
}

/* ---------- WebRTC: listener side ---------- */
async function listenerSignal(d) {
  if (d.sdp) {
    closePeer();
    const pc = (S.pc = new RTCPeerConnection({ iceServers: S.ice }));
    pc.onicecandidate = (e) => { if (e.candidate) send({ type: "signal", to: "master", data: { candidate: e.candidate.toJSON() } }); };
    pc.ontrack = (e) => attachStream(e.streams[0] || new MediaStream([e.track]));
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (S.pc !== pc) return;
      if (st === "connected") { setStatus("CONNECTED"); S.resynced = 0; }
      else if (st === "connecting") setStatus("CONNECTING");
      else if (st === "disconnected") { setStatus("RECONNECTING"); setTimeout(() => { if (S.pc === pc && pc.connectionState !== "connected") send({ type: "resync" }); }, 4000); }
      else if (st === "failed") { if (S.resynced++ < 3) { setStatus("RECONNECTING"); send({ type: "resync" }); } else { setStatus("CONNECTION FAILED"); toast("WebRTC connection failed. A TURN server may be needed on this network."); } }
    };
    await pc.setRemoteDescription(d.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    send({ type: "signal", to: "master", data: { sdp: pc.localDescription.toJSON() } });
  } else if (d.candidate && S.pc) { try { await S.pc.addIceCandidate(d.candidate); } catch (e) { console.warn(e); } }
}
async function attachStream(stream) {
  if (S.remote) S.remote.srcObject = null;
  if (S.vsrc) try { S.vsrc.disconnect(); } catch {}
  S.remote = new Audio(); S.remote.srcObject = stream; S.remote.autoplay = true;
  S.vsrc = S.ctx.createMediaStreamSource(stream); S.vsrc.connect(S.analyser); // analyser only: real visualizer on received audio
  await tryPlay();
}
async function tryPlay() {
  try { await S.ctx.resume(); await S.remote.play(); $("#tap").hidden = S.ctx.state !== "running"; }
  catch { $("#tap").hidden = false; }
  syncViz();
}

/* ---------- room state ---------- */
function computePos() {
  const r = S.room;
  if (S.role === "master" && S.audio) return S.audio.currentTime || 0;
  if (!r.isPlaying) return r.masterPosition;
  const p = r.masterPosition + (Date.now() + S.offset - r.lastStateUpdate) / 1000;
  return r.duration ? Math.min(r.duration, p) : p;
}
function applyRoom(state, action) {
  S.room = state;
  if (S.role === "listener") {
    if (S.remote && S.masterOnline) tryPlay();
    if (action === "volume" || action === "welcome") $("#lvol").textContent = Math.round(state.volume * 100) + "%";
  }
  updateUI();
}
function pushState(action) {
  if (S.role !== "master" || !S.audio) return;
  const r = S.room;
  send({ type: "state", action, songName: r.songName, fileName: r.fileName, duration: S.audio.duration || r.duration || 0, isPlaying: !S.audio.paused && !S.audio.ended,
    masterPosition: S.audio.currentTime || 0, volume: S.gain.gain.value });
}
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function updateUI() {
  const r = S.room, m = S.role === "master";
  const has = !!r.songName;
  $("#title").textContent = has ? r.songName : m ? "No song selected" : "Waiting for Master";
  $("#fileName").textContent = has ? r.fileName : "";
  $("#wait").textContent = !m && !has ? "WAITING FOR MASTER" : "";
  const playing = m ? !!S.audio && !S.audio.paused : r.isPlaying;
  $("#pstate").textContent = has ? (playing ? "Playing" : "Paused") : "";
  $("#play").textContent = playing ? "❚❚" : "▶";
  $("#art").classList.toggle("on", playing);
  if (has) { const h = hue(r.songName); $("#art").style.setProperty("--art", `linear-gradient(135deg,hsl(${h} 80% 60%),hsl(${(h + 70) % 360} 80% 55%))`); $("#art").style.setProperty("--glow", `hsla(${h},90%,60%,.5)`); }
  $("#mconn").textContent = S.masterOnline ? "Master connected" : "Master reconnecting…";
  const d = r.duration || 0; $("#dur").textContent = fmt(d);
  syncViz();
}
function tick() {
  if (!S.active || document.hidden) return;
  const p = computePos(), d = S.room.duration || (S.audio && S.audio.duration) || 0;
  $("#cur").textContent = fmt(p);
  if (!S.dragging) $("#seek").value = d ? Math.round((p / d) * 1000) : 0;
}

/* ---------- visualizer ---------- */
const V = { raf: 0, last: 0, f: null, t: null };
function vizWanted() {
  const playing = S.role === "master" ? !!S.audio && !S.audio.paused : S.room.isPlaying && !!S.remote;
  return S.active && cfg.vis && playing && !document.hidden && !$("#playerScr").hidden;
}
function syncViz() {
  if (vizWanted()) { if (!V.raf) V.raf = requestAnimationFrame(drawViz); }
  else if (V.raf || S.active) { cancelAnimationFrame(V.raf); V.raf = 0; const c = $("#viz"); c.getContext("2d").clearRect(0, 0, c.width, c.height); }
}
function drawViz(ts) {
  V.raf = 0; if (!vizWanted()) return syncViz();
  V.raf = requestAnimationFrame(drawViz);
  if (cfg.perf && ts - V.last < 33) return; V.last = ts;
  const c = $("#viz"), dpr = Math.min(devicePixelRatio || 1, 2), w = c.clientWidth * dpr, h = c.clientHeight * dpr;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext("2d"), a = S.analyser;
  if (!V.f || V.f.length !== a.frequencyBinCount) { V.f = new Uint8Array(a.frequencyBinCount); V.t = new Uint8Array(a.fftSize); }
  a.getByteFrequencyData(V.f); a.getByteTimeDomainData(V.t);
  const k = cfg.sens * cfg.intensity, grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "#9b8cff"); grad.addColorStop(1, "#3ee6d3");
  g.clearRect(0, 0, w, h); g.fillStyle = g.strokeStyle = grad; g.lineWidth = 3 * dpr; g.lineCap = "round";
  const bins = Math.floor(V.f.length * .7), lvl = (i) => Math.min(1, (V.f[i] / 255) * cfg.sens) * cfg.intensity;
  switch (cfg.style) {
    case "wave": g.beginPath(); for (let i = 0; i < V.t.length; i += 4) { const x = (i / V.t.length) * w, y = h / 2 + ((V.t[i] - 128) / 128) * (h / 2) * k; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke(); break;
    case "spectrum": g.beginPath(); g.moveTo(0, h); for (let i = 0; i < 96; i++) g.lineTo((i / 95) * w, h - lvl(Math.floor((i / 96) * bins)) * h); g.lineTo(w, h); g.globalAlpha = .7; g.fill(); g.globalAlpha = 1; break;
    case "circular": { const n = 64, cx = w / 2, cy = h / 2, r0 = h * .22; for (let i = 0; i < n; i++) { const ang = (i / n) * 6.283, l = lvl(Math.floor((i / n) * bins * .6)) * h * .3; g.beginPath(); g.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0); g.lineTo(cx + Math.cos(ang) * (r0 + l + 2), cy + Math.sin(ang) * (r0 + l + 2)); g.stroke(); } break; }
    case "pulse": { let s = 0; for (let i = 0; i < 40; i++) s += V.f[i]; const l = Math.min(1, (s / 40 / 255) * cfg.sens) * cfg.intensity; g.globalAlpha = .35 + l * .5; g.beginPath(); g.arc(w / 2, h / 2, h * .12 + l * h * .36, 0, 6.283); g.fill(); g.globalAlpha = 1; break; }
    default: { const n = 40, bw = w / n; for (let i = 0; i < n; i++) { const l = Math.max(.02, lvl(Math.floor((i / n) * bins))); g.beginPath(); g.roundRect(i * bw + bw * .15, h - l * h, bw * .7, l * h, bw * .3); g.fill(); } }
  }
}

/* ---------- master controls ---------- */
const clampT = (t) => Math.max(0, Math.min(S.audio.duration || 0, t));
async function play() { if (!S.audio.src) return toast("Select a song first"); await S.ctx.resume(); await S.audio.play(); pushState("play"); updateUI(); }
function pause() { S.audio.pause(); pushState("pause"); updateUI(); }
function stopPlay() { S.audio.pause(); S.audio.currentTime = 0; pushState("stop"); updateUI(); }
function seekTo(t) { if (!S.audio.src) return; S.audio.currentTime = clampT(t); pushState("seek"); }
let volT = 0;
function setVol(v) {
  S.gain.gain.value = v; $("#volLbl").textContent = Math.round(v * 100) + "%";
  clearTimeout(volT); volT = setTimeout(() => pushState("volume"), 80); // Web Audio gain: 0-200%, baked into the WebRTC stream
}
function pickFile(f) {
  if (!f) return;
  if (S.url) URL.revokeObjectURL(S.url);
  S.url = URL.createObjectURL(f); // stays local, never uploaded
  S.room.songName = f.name.replace(/\.[^.]+$/, ""); S.room.fileName = f.name;
  S.audio.src = S.url; S.audio.load(); updateUI();
}

/* ---------- navigation / lifecycle ---------- */
function cleanup() {
  S.closing = true; S.active = false;
  clearInterval(S.hb); clearInterval(S.tick); clearTimeout(volT);
  cancelAnimationFrame(V.raf); V.raf = 0;
  try { S.ws && S.ws.close(); } catch {}
  for (const pc of S.pcs.values()) try { pc.close(); } catch {}
  if (S.pc) try { S.pc.close(); } catch {}
  if (S.remote) { S.remote.pause(); S.remote.srcObject = null; }
  if (S.audio) { S.audio.pause(); S.audio.removeAttribute("src"); S.audio.load(); }
  if (S.dest) S.dest.stream.getTracks().forEach((t) => t.stop());
  if (S.url) URL.revokeObjectURL(S.url);
  try { S.ctx && S.ctx.close(); } catch {}
  const c = $("#viz"); c.getContext("2d").clearRect(0, 0, c.width, c.height);
  $("#tap").hidden = true; $("#file").value = "";
  resetState(); loadIce();
}
function endRoom(title, msg) { cleanup(); $("#endTitle").textContent = title; $("#endMsg").textContent = msg; show("endScr"); }
function goHome() {
  if (S.role === "master" && S.active) return $("#cfm").showModal();
  cleanup(); show("home");
}
function enterPlayer(role) {
  S.role = role; S.active = true; S.closing = false; document.body.dataset.role = role;
  $("#roleTag").textContent = role === "master" ? "Master room" : "Listening";
  $("#roomCode").textContent = S.code; $("#vol").value = 100; $("#volLbl").textContent = "100%"; $("#lvol").textContent = "100%";
  $("#seek").disabled = role !== "master";
  setStatus("CONNECTING"); updateCount(0); updateUI(); show("playerScr");
  S.tick = setInterval(safe(tick), 250);
}
function joinScreen(err) { show("joinScr"); $("#joinErr").textContent = err || ""; }
async function loadIce() { try { const r = await fetch("/api/config"); const j = await r.json(); if (Array.isArray(j.iceServers)) S.ice = j.iceServers; } catch {} }

const create = safe(async () => {
  let res;
  try { res = await fetch("/api/create", { method: "POST" }); if (!res.ok) throw 0; res = await res.json(); } catch { return toast("Could not create room"); }
  try { initMasterAudio(); } catch { return toast("This browser does not support Web Audio"); }
  S.code = res.code; S.token = res.token; S.role = "master";
  enterPlayer("master"); connect();
});
const joinRoom = safe(() => {
  const code = $("#code").value.trim();
  if (!/^\d{6}$/.test(code)) return ($("#joinErr").textContent = "Enter the 6-digit code");
  try { makeCtx(); } catch { return toast("This browser does not support Web Audio"); }
  S.code = code; S.role = "listener"; enterPlayer("listener"); connect();
});

function init() {
  bindSettings(); particles(); loadIce();
  document.addEventListener("visibilitychange", safe(() => { particles(); syncViz(); if (!document.hidden && S.ctx && S.ctx.state === "suspended" && S.role === "master") S.ctx.resume(); }));
  addEventListener("resize", safe(() => cfg.parts && particles()));
  $("#intro").addEventListener("click", () => ($("#intro").style.display = "none"));
  setTimeout(() => ($("#intro").style.display = "none"), 3800);
  $("#create").onclick = create;
  $("#join").onclick = () => joinScreen();
  $("#joinGo").onclick = joinRoom;
  $("#code").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); $("#joinErr").textContent = ""; });
  $("#code").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });
  $("#homeBtn").onclick = safe(goHome);
  $("#endHome").onclick = () => show("home");
  $("#cfmNo").onclick = () => $("#cfm").close();
  $("#cfmYes").onclick = safe(() => { $("#cfm").close(); send({ type: "close" }); endRoom("Room closed", "You ended this room."); });
  $("#copy").onclick = safe(async () => { try { await navigator.clipboard.writeText(S.code); toast("Code copied"); } catch { toast("Room code: " + S.code); } });
  $("#share").onclick = safe(async () => {
    const data = { title: "SYNCWAVE", text: `Join my SYNCWAVE room with code ${S.code}`, url: location.origin };
    if (navigator.share) { try { await navigator.share(data); } catch {} } else $("#copy").click();
  });
  $("#pick").onclick = () => $("#file").click();
  $("#file").onchange = safe((e) => pickFile(e.target.files[0]));
  $("#play").onclick = safe(() => (S.audio.paused ? play() : pause()));
  $("#stopBtn").onclick = safe(stopPlay);
  $("#back").onclick = safe(() => seekTo(S.audio.currentTime - 10));
  $("#fwd").onclick = safe(() => seekTo(S.audio.currentTime + 10));
  $("#seek").addEventListener("input", () => { S.dragging = true; const d = (S.audio && S.audio.duration) || 0; $("#cur").textContent = fmt((+$("#seek").value / 1000) * d); });
  $("#seek").addEventListener("change", safe(() => { S.dragging = false; if (S.role === "master") seekTo((+$("#seek").value / 1000) * (S.audio.duration || 0)); }));
  $("#vol").addEventListener("input", safe((e) => S.role === "master" && setVol(e.target.value / 100)));
  $("#stopListen").onclick = safe(() => { cleanup(); $("#endTitle").textContent = "Listening stopped"; $("#endMsg").textContent = "You left the room. Other listeners are not affected."; show("endScr"); });
  $("#tap").onclick = safe(() => tryPlay());
  addEventListener("beforeunload", (e) => { if (S.role === "master" && S.active) { e.preventDefault(); e.returnValue = ""; } });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
}
window.addEventListener("error", () => toast("Something went wrong"));
window.addEventListener("unhandledrejection", (e) => console.error(e.reason));
init();
