#!/usr/bin/env node
/**
 * npm run test:relay — F3: relay agent → server → viewer remoto.
 *
 * Se conecta como si estuviera en otra red (sólo habla con el server por
 * WebSocket/HTTP, nunca con el agent de la LAN) y comprueba:
 *   1. el WS rechaza conexiones sin token,
 *   2. al suscribirse llegan frames JPEG,
 *   3. dos espectadores reciben a la vez,
 *   4. GET /frame.jpg devuelve la última imagen (y exige JWT),
 *   5. al dejar de mirar, el agent apaga FFmpeg y dejan de llegar frames.
 *
 * Requisitos: server + agent levantados y una cámara registrada.
 */
import { io } from "socket.io-client";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://localhost:4000";
const AGENT = "http://localhost:4100";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envText = readFileSync(resolve(root, ".env"), "utf8");
const val = (n) => (envText.match(new RegExp(`^${n}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";

const results = [];
let failures = 0;
const check = (ok, label) => {
  results.push(`${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- auth ------------------------------------------------------------------
// Credenciales del test en .env (nunca en el repositorio).
const EMAIL = process.env.TEST_EMAIL || val("TEST_EMAIL") || "";
const PASSWORD = process.env.TEST_PASSWORD || val("TEST_PASSWORD") || "";
if (!EMAIL || !PASSWORD) {
  console.error("Faltan TEST_EMAIL y TEST_PASSWORD en .env (no se guardan contraseñas en el repo)");
  process.exit(2);
}

const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).then((r) => r.json());
const token = login.token;
check(Boolean(token), "login → JWT");
if (!token) {
  console.log(results.join("\n"));
  process.exit(1);
}

const cameras = await fetch(`${BASE}/api/v1/cameras`).then((r) => r.json());
const camera = cameras.cameras?.[0];
check(Boolean(camera), `cámara registrada (${cameras.cameras?.length ?? 0})`);
if (!camera) {
  console.log(results.join("\n"));
  process.exit(1);
}
const cameraId = camera.id;

// --- línea base: cuánta gente lo mira ya (la pestaña de la app, etc.) ------
const agentView = async () =>
  (await fetch(`${AGENT}/api/status`).then((r) => r.json())).cameras?.find((c) => c.cameraId === cameraId);
const baselineViewers = (await agentView())?.viewers ?? 0;
results.push(`INFO  espectadores locales antes del test: ${baselineViewers}`);

// --- 1. el WS exige token ---------------------------------------------------
const anonymous = io(BASE, { transports: ["websocket"], reconnection: false, timeout: 3000 });
const rejected = await new Promise((res) => {
  const t = setTimeout(() => res(false), 3500);
  anonymous.on("connect", () => {
    clearTimeout(t);
    res(false);
  });
  anonymous.on("connect_error", () => {
    clearTimeout(t);
    res(true);
  });
});
check(rejected, "WS sin token → rechazado (connect_error)");
anonymous.disconnect();

// --- helper de espectador ---------------------------------------------------
function viewer(name) {
  const socket = io(BASE, {
    transports: ["websocket"],
    reconnection: false,
    auth: { token },
  });
  const state = {
    name,
    socket,
    frames: [],
    seqs: [],
    bytes: 0,
    errors: 0,
    acks: 0,
    connected: false,
  };
  socket.on("connect", () => (state.connected = true));
  socket.on("connect_error", (e) => state.errors++);
  socket.on("stream:frame", (header, payload, ack) => {
    const buf = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(payload instanceof ArrayBuffer ? payload : new Uint8Array(payload));
    if (buf.subarray(0, 3).toString("hex") !== "ffd8ff") return;
    state.frames.push({ seq: header?.seq, ts: header?.ts, bytes: buf.length });
    // seq=-1 es el frame de "puesta al día" (el último cacheado): no cuenta
    // para la secuencia en vivo.
    if (typeof header?.seq === "number" && header.seq >= 0) state.seqs.push(header.seq);
    state.bytes += buf.length;
    if (typeof ack === "function") {
      ack();
      state.acks++;
    }
  });
  return state;
}

async function subscribe(state) {
  await new Promise((res) => {
    if (state.socket.connected) return res();
    state.socket.on("connect", res);
    state.socket.on("connect_error", res);
    setTimeout(res, 4000);
  });
  if (!state.socket.connected) return false;
  return await new Promise((res) => {
    state.socket.emit("viewer:subscribe", { type: "viewer:subscribe", cameraId }, (r) => res(Boolean(r?.ok)));
    setTimeout(() => res(false), 4000);
  });
}

// --- 2 y 3. dos espectadores remotos ---------------------------------------
const a = viewer("A");
const b = viewer("B");
const [subA, subB] = await Promise.all([subscribe(a), subscribe(b)]);
check(subA, "espectador A: viewer:subscribe → ack ok");
check(subB, "espectador B: viewer:subscribe → ack ok");

console.log("   … recolectando frames durante 6 s (relay agent → server → viewer)");
await sleep(6000);

check(a.frames.length >= 15, `A recibió ${a.frames.length} frames en 6 s (≥15 ≈ 6 fps)`);
check(b.frames.length >= 15, `B recibió ${b.frames.length} frames en 6 s`);
check(a.bytes > 200_000, `A: ${(a.bytes / 1024).toFixed(0)} KB de JPEG`);
check(a.acks > 0, `A confirmó frames al server (backpressure): ${a.acks} acks`);

const ascending = a.seqs.every((v, i) => i === 0 || v > a.seqs[i - 1]);
check(ascending, `seq de A monótona creciente (${a.seqs[0]}…${a.seqs[a.seqs.length - 1]})`);

const sameRate = Math.abs(a.frames.length - b.frames.length) <= Math.max(3, a.frames.length * 0.2);
check(sameRate, `A y B reciben parecido (${a.frames.length} vs ${b.frames.length})`);

// el agent debe ver exactamente +1 espectador más (el relay)
const during = await agentView();
check(
  during?.viewers === baselineViewers + 1,
  `el agent registra el relay como espectador (${baselineViewers} → ${during?.viewers})`,
);
check(during?.state === "running", `pipeline encendido mientras hay espectadores (state=${during?.state})`);

// --- 4. API REST de última imagen ------------------------------------------
const withToken = await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`, {
  headers: { authorization: `Bearer ${token}` },
});
const jpg = Buffer.from(await withToken.arrayBuffer());
check(withToken.status === 200, `GET /frame.jpg con JWT → ${withToken.status}`);
check(jpg.subarray(0, 3).toString("hex") === "ffd8ff", `/frame.jpg es JPEG real (${jpg.length} bytes)`);
check((withToken.headers.get("content-type") ?? "").includes("image/jpeg"), `content-type: ${withToken.headers.get("content-type")}`);

const noToken = await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`);
check(noToken.status === 401, `GET /frame.jpg sin token → ${noToken.status} (no se filtra la imagen)`);

// --- 5. apagado on-demand ---------------------------------------------------
const unsub = (state) =>
  new Promise((res) => {
    state.socket.emit("viewer:unsubscribe", { type: "viewer:unsubscribe", cameraId }, (r) => res(Boolean(r?.ok)));
    setTimeout(() => res(false), 3000);
  });
check(await unsub(a), "A: viewer:unsubscribe → ack ok");
check(await unsub(b), "B: viewer:unsubscribe → ack ok");
await sleep(600);

// el relay debe desprenderse: el contador de espectadores vuelve a la línea base
const afterRelease = await agentView();
check(
  afterRelease?.viewers === baselineViewers,
  `relay desprendido: viewers ${baselineViewers} → ${during?.viewers} → ${afterRelease?.viewers}`,
);

const ageBefore = Number(
  (
    await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`, { headers: { authorization: `Bearer ${token}` } })
  ).headers.get("x-frame-age-ms") ?? -1,
);
await sleep(2500);
const ageAfter = Number(
  (
    await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`, { headers: { authorization: `Bearer ${token}` } })
  ).headers.get("x-frame-age-ms") ?? -1,
);
check(ageAfter > ageBefore + 1500, `sin espectadores dejan de llegar frames (edad ${ageBefore} ms → ${ageAfter} ms)`);

// --- 6. el ciclo attach/detach funciona (volver a mirar reanuda el relay) ---
const countBeforeResume = a.frames.length;
check(await subscribe(a), "A: re-suscripción → ack ok");
await sleep(3000);
const resumed = a.frames.length - countBeforeResume;
check(resumed >= 8, `relay reanudado: +${resumed} frames en 3 s`);
check(await unsub(a), "A: baja de nuevo → ack ok");

// --- 7. FFmpeg se apaga cuando nadie lo mira -------------------------------
// Si alguien más lo está mirando en local (p.ej. la pestaña de la app abierta),
// el pipeline sigue encendido y eso es correcto: sólo se puede verificar el
// apagado cuando `viewers` llega a 0.
await sleep(1200);
const agentStatus = await fetch(`${AGENT}/api/status`).then((r) => r.json());
const pipe = (agentStatus.cameras ?? []).find((c) => c.cameraId === cameraId);
check(Boolean(pipe), "el agent sigue vivo y reporta la cámara");

if ((pipe?.viewers ?? 0) > 0) {
  results.push(`INFO  FFmpeg encendido porque otro espectador local lo mira (viewers=${pipe.viewers})`);
  results.push("INFO  el apagado on-demand se verifica con AGENT_NO_VIEWER_STOP_MS y nadie mirando");
} else {
  const stopDelay = Number(process.env.AGENT_NO_VIEWER_STOP_MS || val("AGENT_NO_VIEWER_STOP_MS") || 60000);
  await sleep(stopDelay + 2500);
  const after = await fetch(`${AGENT}/api/status`).then((r) => r.json());
  const stopped = (after.cameras ?? []).find((c) => c.cameraId === cameraId);
  check(stopped?.state === "stopped", `FFmpeg apagado sin espectadores (state=${stopped?.state})`);
  check((stopped?.viewers ?? -1) === 0, `viewers locales = ${stopped?.viewers}`);
}

a.socket.disconnect();
b.socket.disconnect();

console.log(results.join("\n"));
console.log(failures === 0 ? "\nF3 RELAY OK" : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
