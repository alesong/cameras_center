#!/usr/bin/env node
/**
 * npm run test:f5 — F5: API pública (API keys + docs + rate limits).
 *
 * Comprueba que un tercero puede consumir la API sin compartir el JWT:
 *   1. CRUD de API keys (sólo JWT de owner; la clave se ve una sola vez)
 *   2. la key abre lectura: frame.jpg, thumbnails, stream MJPEG
 *   3. la key NO escribe (crear/borrar cámaras o keys → 401)
 *   4. scopes: sin `stream` no puede suscribirse al WebSocket
 *   5. revocada → deja de valer al instante
 *   6. rate limit por key → 429 con X-RateLimit-* y Retry-After
 *   7. /api/openapi.json y /api/docs responden
 *   8. regresión: el JWT sigue funcionando igual
 *
 * Requiere: server + agent levantados (frames) y TEST_EMAIL/TEST_PASSWORD.
 * Al terminar revoca las keys que crea (soft delete: quedan como traza de auditoría).
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
const created = []; // keys creadas por este test, para limpiar al final

// --- 1. gestión de keys exige JWT -------------------------------------------
const keysNoAuth = await fetch(`${BASE}/api/v1/keys`);
check(keysNoAuth.status === 401, `GET /keys sin token → ${keysNoAuth.status}`);

const keysListBefore = await fetch(`${BASE}/api/v1/keys`, { headers: auth }).then((r) => r.json());
check(Array.isArray(keysListBefore?.keys), "GET /keys con JWT → lista", `backend=${keysListBefore?.backend}`);

async function createKey(body) {
  const res = await fetch(`${BASE}/api/v1/keys`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (data.apikey?.id) created.push(data.apikey.id);
  return { status: res.status, data };
}

const main = await createKey({ label: "f5-test", scopes: ["read", "stream"], rate_limit: 300 });
check(main.status === 201, `POST /keys → ${main.status}`);
check(/^cc_live_[0-9a-f]{40}$/.test(main.data.key ?? ""), "la key devuelta tiene formato cc_live_<40 hex>");
check(Boolean(main.data.apikey?.id), "el registro público no incluye la clave", JSON.stringify(main.data.apikey ?? {}));
check(Boolean(main.data.warning), "avisa de que la clave se muestra una sola vez");
const apiKey = main.data.key;
if (!apiKey) {
  console.log(results.join("\n"));
  process.exit(1);
}

const readOnly = await createKey({ label: "f5-readonly", scopes: ["read"], rate_limit: 60 });
const limiter = await createKey({ label: "f5-limiter", scopes: ["read"], rate_limit: 5 });
check(readOnly.status === 201 && limiter.status === 201, "keys auxiliares creadas (read-only y rate 5)");

const keysList = await fetch(`${BASE}/api/v1/keys`, { headers: auth }).then((r) => r.json());
check((keysList.keys ?? []).length >= 3, `la lista incluye las nuevas (${keysList.keys?.length ?? 0})`);
check(!JSON.stringify(keysList).includes("cc_live_"), "la lista NUNCA expone claves en claro");

// --- 2. frames: un espectador con JWT para que haya imagen --------------------
const socket = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token } });
let jwtFrames = 0;
socket.on("stream:frame", (_h, _p, ack) => {
  jwtFrames += 1;
  if (typeof ack === "function") ack();
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
check(subOk, "viewer:subscribe con JWT → ack ok");

console.log("   … esperando frames (4 s)");
await sleep(4000);
check(jwtFrames >= 5, `frames recibidos con JWT: ${jwtFrames}`);

// --- 3. la API key abre la lectura -------------------------------------------
const frameWithKey = await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`, {
  headers: { "x-api-key": apiKey },
});
const frameType = frameWithKey.headers.get("content-type") ?? "";
check(frameWithKey.status === 200, `frame.jpg con X-API-Key → ${frameWithKey.status}`, frameType);
const frameBytes = Buffer.from(await frameWithKey.arrayBuffer());
check(
  frameBytes[0] === 0xff && frameBytes[1] === 0xd8,
  `el body es un JPEG real (${frameBytes.length} bytes)`,
);

const frameBearer = await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`, {
  headers: { authorization: `Bearer ${apiKey}` },
});
check(frameBearer.status === 200, `frame.jpg con Authorization: Bearer <key> → ${frameBearer.status}`);
check(
  frameBearer.headers.get("x-ratelimit-limit") === "300",
  "cabeceras X-RateLimit-* presentes",
  `limit=${frameBearer.headers.get("x-ratelimit-limit")} remaining=${frameBearer.headers.get("x-ratelimit-remaining")}`,
);

const thumbsWithKey = await fetch(`${BASE}/api/v1/cameras/thumbnails`, { headers: { "x-api-key": apiKey } });
check(thumbsWithKey.status === 200, `GET /cameras/thumbnails con API key → ${thumbsWithKey.status}`);

const frameNoCreds = await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`);
check(frameNoCreds.status === 401, `frame.jpg sin credenciales → ${frameNoCreds.status}`);

// --- 4. una API key NO escribe -----------------------------------------------
const writeWithKey = await fetch(`${BASE}/api/v1/cameras`, {
  method: "POST",
  headers: { "x-api-key": apiKey, "content-type": "application/json" },
  body: JSON.stringify({ name: "no", connection: "rtsp://x" }),
});
check(writeWithKey.status === 401, `POST /cameras con API key → ${writeWithKey.status} (escritura sólo JWT)`);
const body = await writeWithKey.json().catch(() => ({}));
check(/JWT/i.test(body.error ?? ""), "el 401 explica que hace falta JWT", body.error ?? "");

const deleteWithKey = await fetch(`${BASE}/api/v1/cameras/${cameraId}`, {
  method: "DELETE",
  headers: { "x-api-key": apiKey },
});
check(deleteWithKey.status === 401, `DELETE /cameras con API key → ${deleteWithKey.status}`);

const createKeyWithKey = await fetch(`${BASE}/api/v1/keys`, {
  method: "POST",
  headers: { "x-api-key": apiKey, "content-type": "application/json" },
  body: JSON.stringify({ label: "cadena" }),
});
check(createKeyWithKey.status === 401, `POST /keys con API key → ${createKeyWithKey.status}`);

const noScopeWrite = await fetch(`${BASE}/api/v1/keys`, {
  method: "POST",
  headers: { "x-api-key": readOnly.data.key, "content-type": "application/json" },
  body: JSON.stringify({ label: "n2" }),
});
check(noScopeWrite.status === 401, `POST /keys con key read-only → ${noScopeWrite.status}`);

// --- 5. scopes de stream en el WebSocket -------------------------------------
async function wsAttempt(key, subscribe) {
  const s = io(BASE, { transports: ["websocket"], reconnection: false, auth: { token: key } });
  const connected = await new Promise((res) => {
    s.on("connect", () => res(true));
    s.on("connect_error", () => res(false));
    setTimeout(() => res(false), 4000);
  });
  if (!connected) {
    s.disconnect();
    return { connected: false };
  }
  const ack = subscribe
    ? await new Promise((res) => {
        s.emit("viewer:subscribe", { type: "viewer:subscribe", cameraId }, (r) => res(r));
        setTimeout(() => res({ ok: false, error: "sin-ack" }), 4000);
      })
    : { ok: true };
  return { connected: true, ack, socket: s };
}

const badKey = "cc_live_" + "0".repeat(40);
const bad = await wsAttempt(badKey, false);
check(!bad.connected, "WS con key inexistente → rechazado");

const ro = await wsAttempt(readOnly.data.key, true);
check(
  !ro.connected || ro.ack?.ok === false,
  "key sin scope `stream` → no puede ver vídeo",
  `connected=${ro.connected} ack=${JSON.stringify(ro.ack ?? {})}`,
);
if (ro.socket) ro.socket.disconnect();

const withStream = await wsAttempt(apiKey, true);
check(withStream.connected && withStream.ack?.ok === true, "key con scope `stream` → suscrito", JSON.stringify(withStream.ack ?? {}));
let keyFrames = 0;
if (withStream.socket) {
  withStream.socket.on("stream:frame", (_h, _p, ack) => {
    keyFrames += 1;
    if (typeof ack === "function") ack();
  });
  await sleep(4000);
  check(keyFrames >= 3, `frames recibidos con API key: ${keyFrames}`);
  withStream.socket.disconnect();
}

// --- 6. stream MJPEG para terceros -------------------------------------------
const controller = new AbortController();
const mjpg = await fetch(`${BASE}/api/v1/streams/${cameraId}.mjpg`, {
  headers: { "x-api-key": apiKey },
  signal: controller.signal,
});
const mjpgType = mjpg.headers.get("content-type") ?? "";
check(mjpg.status === 200, `GET /streams/:id.mjpg → ${mjpg.status}`);
check(mjpgType.includes("multipart/x-mixed-replace"), "content-type multipart/x-mixed-replace", mjpgType);

let chunk = Buffer.alloc(0);
if (mjpg.body) {
  const reader = mjpg.body.getReader();
  const deadline = Date.now() + 15000;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunk = Buffer.concat([chunk, Buffer.from(value)]);
      if (chunk.includes(Buffer.from("image/jpeg")) && chunk.length > 8000) break;
    }
  } catch {
    // lectura interrumpida: lo importante es lo que ya se acumuló
  }
}
const text = chunk.toString("latin1");
check(text.includes("Content-Type: image/jpeg"), "el stream trae partes image/jpeg");
const magic = chunk.indexOf(Buffer.from([0xff, 0xd8]));
check(magic >= 0, `JPEG embebido en el MJPEG (${chunk.length} bytes leídos)`);

const healthDuring = await fetch(`${BASE}/api/health`).then((r) => r.json());
check((healthDuring.ws?.http ?? 0) >= 1, "health.ws.http cuenta al espectador MJPEG", JSON.stringify(healthDuring.ws));
check(Boolean(healthDuring.rateLimit), "health.rateLimit presente", JSON.stringify(healthDuring.rateLimit));
check(Boolean(healthDuring.apiKeys), "health.apiKeys presente", JSON.stringify(healthDuring.apiKeys));

controller.abort();
await sleep(1500);
const healthAfter = await fetch(`${BASE}/api/health`).then((r) => r.json());
check((healthAfter.ws?.http ?? 0) === 0, `al cerrarse, los espectadores MJPEG vuelven a 0 (${healthAfter.ws?.http ?? "?"})`);

const mjpgNoAuth = await fetch(`${BASE}/api/v1/streams/${cameraId}.mjpg`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
check((mjpgNoAuth?.status ?? 0) === 401, `MJPEG sin credenciales → ${mjpgNoAuth?.status ?? "?"}`);

// --- 7. rate limit por API key ------------------------------------------------
if (limiter.data.key) {
  const codes = [];
  let limited = null;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(`${BASE}/api/v1/cameras/thumbnails`, { headers: { "x-api-key": limiter.data.key } });
    codes.push(res.status);
    if (res.status === 429 && !limited) {
      limited = {
        retryAfter: res.headers.get("retry-after"),
        limit: res.headers.get("x-ratelimit-limit"),
        remaining: res.headers.get("x-ratelimit-remaining"),
        body: await res.json().catch(() => ({})),
      };
    }
  }
  check(codes.filter((c) => c === 429).length >= 6, `12 peticiones con rate 5 → 429 en ${codes.filter((c) => c === 429).length}`, codes.join(","));
  check(limited?.limit === "5", "X-RateLimit-Limit = 5", `limit=${limited?.limit}`);
  check(limited?.remaining === "0", "X-RateLimit-Remaining = 0", `remaining=${limited?.remaining}`);
  check(Boolean(limited?.retryAfter), "Retry-After presente", `retry-after=${limited?.retryAfter}`);
  check(Number(limited?.retryAfter) > 0, "Retry-After > 0", String(limited?.retryAfter));
  check(/excedido/i.test(limited?.body?.error ?? ""), "cuerpo 429 accionable", limited?.body?.error ?? "");
} else {
  check(false, "no se pudo crear la key de rate limit");
}

// --- 8. documentación ---------------------------------------------------------
const openapiRes = await fetch(`${BASE}/api/openapi.json`);
const openapi = await openapiRes.json().catch(() => ({}));
check(openapiRes.status === 200, `/api/openapi.json → ${openapiRes.status}`);
check(String(openapi.openapi ?? "").startsWith("3."), "especificación OpenAPI 3.x", openapi.openapi ?? "");
const paths = Object.keys(openapi.paths ?? {});
check(paths.includes("/api/v1/keys"), "documenta POST/GET /api/v1/keys");
check(paths.includes("/api/v1/streams/{id}.mjpg"), "documenta el stream MJPEG", paths.filter((p) => p.includes("streams")).join(",") || "sin rutas de stream");
check(Boolean(openapi.components?.securitySchemes?.apiKeyAuth), "declara el security scheme X-API-Key");
check(Boolean(openapi.components?.securitySchemes?.bearerAuth), "declara el security scheme Bearer JWT");

const docsRes = await fetch(`${BASE}/api/docs`);
const docsHtml = await docsRes.text();
check(docsRes.status === 200, `/api/docs → ${docsRes.status}`);
check((docsRes.headers.get("content-type") ?? "").includes("text/html"), "el docs es HTML", docsRes.headers.get("content-type") ?? "");
check(docsHtml.includes("Cameras Center"), "la página de docs carga");
check(docsHtml.includes("viewer:subscribe"), "documenta el protocolo WebSocket");

// --- 9. revocar ---------------------------------------------------------------
const revoke = await fetch(`${BASE}/api/v1/keys/${main.data.apikey.id}`, { method: "DELETE", headers: auth });
check(revoke.status === 204, `DELETE /keys/:id → ${revoke.status}`);

const afterRevoke = await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`, {
  headers: { "x-api-key": apiKey },
});
check(afterRevoke.status === 401, `key revocada → ${afterRevoke.status}`);

const revokeTwice = await fetch(`${BASE}/api/v1/keys/${main.data.apikey.id}`, { method: "DELETE", headers: auth });
check(revokeTwice.status === 404, `revoke repetido → ${revokeTwice.status}`);

// --- 10. regresión JWT --------------------------------------------------------
const frameWithJwt = await fetch(`${BASE}/api/v1/cameras/${cameraId}/frame.jpg`, { headers: auth });
check(frameWithJwt.status === 200, `regresión: frame.jpg con JWT → ${frameWithJwt.status}`);

const listAfter = await fetch(`${BASE}/api/v1/keys`, { headers: auth }).then((r) => r.json());
check(
  (listAfter.keys ?? []).some((k) => k.revoked && k.id === main.data.apikey.id),
  "la key revocada sigue listada (constancia)",
);

// --- limpieza ------------------------------------------------------------------
for (const id of created) {
  if (id === main.data.apikey?.id) continue;
  await fetch(`${BASE}/api/v1/keys/${id}`, { method: "DELETE", headers: auth }).catch(() => {});
}

socket.disconnect();

console.log(results.join("\n"));
console.log(failures === 0 ? "\nF5 OK" : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
