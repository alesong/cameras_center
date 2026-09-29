#!/usr/bin/env node
/**
 * npm run test:f4 — F4: thumbnails en Cloudinary + health ampliado.
 *
 * Simula un espectador (para que lleguen frames al server) y comprueba:
 *   1. /api/health expone ws / frames / cloudinary
 *   2. GET /cameras/thumbnails exige JWT
 *   3. POST /cameras/:id/thumbnail sube el frame a Cloudinary y devuelve URL
 *   4. esa URL sirve un JPEG real (descarga desde Cloudinary)
 *   5. el resto de endpoints siguen exigiendo token (regresión F3)
 *
 * Requiere: server + agent levantados, CLOUDINARY_URL y TEST_EMAIL/TEST_PASSWORD.
 */
import { io } from "socket.io-client";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = "http://localhost:4000";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const envText = readFileSync(resolve(root, ".env"), "utf8");
const val = (n) => (envText.match(new RegExp(`^${n}=(.*)$`, "m")) ?? [])[1]?.trim() ?? "";

const results = [];
let failures = 0;
const check = (ok, label, extra = "") => {
  results.push(`${ok ? "OK  " : "FAIL"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};
const info = (label) => results.push(`INFO  ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const email = process.env.TEST_EMAIL || val("TEST_EMAIL");
const password = process.env.TEST_PASSWORD || val("TEST_PASSWORD");
if (!email || !password) {
  console.error("Faltan TEST_EMAIL y TEST_PASSWORD en .env");
  process.exit(2);
}

// --- auth -------------------------------------------------------------------
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
}).then((r) => r.json());
const token = login.token;
check(Boolean(token), "login → JWT");
if (!token) {
  console.log(results.join("\n"));
  process.exit(1);
}
const auth = { authorization: `Bearer ${token}` };

const cameras = await fetch(`${BASE}/api/v1/cameras`).then((r) => r.json());
const camera = cameras.cameras?.[0];
check(Boolean(camera), `cámara registrada (${cameras.cameras?.length ?? 0})`);
if (!camera) {
  console.log(results.join("\n"));
  process.exit(1);
}
const cameraId = camera.id;

// --- 1. health ampliado -----------------------------------------------------
const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
check(Boolean(health.ws), "health → sección ws", JSON.stringify(health.ws));
check(Boolean(health.frames), "health → sección frames", JSON.stringify(health.frames));
check(Boolean(health.cloudinary), "health → sección cloudinary");
check(health.cloudinary?.configured === true, "CLOUDINARY_URL configurado", health.cloudinary?.folder);
check(health.integrations?.cloudinary === "configured", "integrations.cloudinary = configured");

const configured = health.cloudinary?.configured === true;
if (!configured) info("sin CLOUDINARY_URL: se omiten las comprobaciones de subida");

// --- 2. los endpoints de thumbnail exigen JWT -------------------------------
const noToken = await fetch(`${BASE}/api/v1/cameras/thumbnails`);
check(noToken.status === 401, `GET /cameras/thumbnails sin token → ${noToken.status}`);

const noTokenCapture = await fetch(`${BASE}/api/v1/cameras/${cameraId}/thumbnail`, { method: "POST" });
check(noTokenCapture.status === 401, `POST /cameras/:id/thumbnail sin token → ${noTokenCapture.status}`);

const frameNoToken = await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`);
check(frameNoToken.status === 401, `regresión F3: /frame.jpg sin token → ${frameNoToken.status}`);

// --- 3. un espectador para que lleguen frames -------------------------------
const socket = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token } });
let frames = 0;
let acks = 0;
socket.on("stream:frame", (_header, _payload, ack) => {
  frames += 1;
  if (typeof ack === "function") {
    ack();
    acks++;
  }
});
await new Promise((res) => {
  socket.on("connect", res);
  socket.on("connect_error", res);
  setTimeout(res, 4000);
});
check(socket.connected, "WS conectado con JWT");

const subOk = await new Promise((res) => {
  if (!socket.connected) return res(false);
  socket.emit("viewer:subscribe", { type: "viewer:subscribe", cameraId }, (r) => res(Boolean(r?.ok)));
  setTimeout(() => res(false), 4000);
});
check(subOk, "viewer:subscribe → ack ok");

console.log("   … 4 s de frames (el server necesita imagen para la thumbnail)");
await sleep(4000);
check(frames >= 5, `frames recibidos: ${frames}`, `acks=${acks}`);

const health2 = await fetch(`${BASE}/api/health`).then((r) => r.json());
check(health2.frames?.cachedCameras >= 1, `frame cacheado en el server (${health2.frames?.cachedCameras})`);
check(health2.ws?.viewers >= 1, `health.ws.viewers = ${health2.ws?.viewers}`);

// --- 4. subida real a Cloudinary --------------------------------------------
let capturedUrl = null;
if (configured) {
  const capture = await fetch(`${BASE}/api/v1/cameras/${cameraId}/thumbnail`, {
    method: "POST",
    headers: auth,
  });
  const body = await capture.json().catch(() => ({}));
  check(capture.status === 200, `POST /thumbnail → ${capture.status}`, body.error ?? "");
  capturedUrl = body.thumbnail?.url ?? null;
  check(Boolean(capturedUrl) && capturedUrl.includes("res.cloudinary.com"), "URL de Cloudinary devuelta", capturedUrl ?? "");

  if (capturedUrl) {
    const image = await fetch(capturedUrl);
    const bytes = Buffer.from(await image.arrayBuffer());
    const type = image.headers.get("content-type") ?? "";
    check(image.status === 200 && type.startsWith("image/"), `descarga desde Cloudinary → ${image.status} ${type}`);
    check(bytes[0] === 0xff && bytes[1] === 0xd8, `el contenido es un JPEG (${bytes.length} bytes)`);

    // y la thumbnail debe quedar publicada en el endpoint de lectura
    const thumbs = await fetch(`${BASE}/api/v1/cameras/thumbnails`, { headers: auth }).then((r) => r.json());
    check(Boolean(thumbs.thumbnails?.[cameraId]), "GET /cameras/thumbnails la incluye", thumbs.thumbnails?.[cameraId]);
    check(
      thumbs.thumbnails?.[cameraId] === capturedUrl,
      "la URL publicada coincide con la capturada",
    );
  }

  const health3 = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check((health3.cloudinary?.uploads ?? 0) >= 1, `health.cloudinary.uploads = ${health3.cloudinary?.uploads}`);
  check((health3.cloudinary?.thumbnails ?? 0) >= 1, `health.cloudinary.thumbnails = ${health3.cloudinary?.thumbnails}`);
}

// --- 5. baja y limpieza ------------------------------------------------------
await new Promise((res) => {
  socket.emit("viewer:unsubscribe", { type: "viewer:unsubscribe", cameraId }, () => res());
  setTimeout(res, 3000);
});
socket.disconnect();

console.log(results.join("\n"));
console.log(failures === 0 ? "\nF4 OK" : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
