import { Router } from "express";
import { API } from "@cameras/protocol";

/**
 * Documentación pública de la API (F5).
 *
 *  - `GET /api/openapi.json` → especificación OpenAPI 3.0 (importable en
 *    Postman/Insomnia/Redocly). Se genera en código: no puede desincronizarse.
 *  - `GET /api/docs`          → página HTML legible (sin dependencias externas,
 *    funciona sin internet y en cualquier navegador).
 */
export const docsRouter = Router();

const SCOPES = ["read", "stream"] as const;

function openapi(base: string) {
  const bearerAuth = { type: "http", scheme: "bearer", bearerFormat: "JWT" } as const;
  const apiKeyHeader = { type: "apiKey", in: "header", name: "X-API-Key" } as const;

  const errorResponse = {
    description: "Error",
    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
  };

  const responses = (okDescription: string, okContent?: Record<string, unknown>) => ({
    "200": {
      description: okDescription,
      ...(okContent ? { content: okContent } : {}),
    },
    "401": errorResponse,
    "403": errorResponse,
    "429": errorResponse,
    "500": errorResponse,
  });

  const json = (schema: unknown) => ({ "application/json": { schema } });

  return {
    openapi: "3.0.3",
    info: {
      title: "Cameras Center API",
      version: "1.0.0",
      description:
        "API para consultar cámaras IP y recibir sus imágenes en tiempo real.\n\n" +
        "**Autenticación.** Dos formas:\n" +
        "- `Authorization: Bearer <JWT>` — usuario de la app (escritura y lectura).\n" +
        "- `X-API-Key: cc_live_…` o `Authorization: Bearer cc_live_…` — API key de tercero (sólo lectura/stream).\n\n" +
        "**Límites.** 300 peticiones/min por IP (`RATE_LIMIT_RPM`) y el `rate_limit` " +
        "propio de cada API key (60/min por defecto). Al superarlos se devuelve `429` " +
        "con `X-RateLimit-*` y `Retry-After`.\n\n" +
        "**WebSocket.** El vídeo se emite por socket.io en `stream:frame`: conéctate a la raíz del servidor " +
        "con `auth: { token: <JWT|API key> }`, emite `viewer:subscribe` con `{ cameraId }` y " +
        "recibes binario `stream:frame` (cabecera `parseFrameHeader` + JPEG). " +
        "Ver la sección «Tiempo real» de /api/docs.",
      contact: { name: "Cameras Center" },
    },
    servers: [{ url: base }],
    tags: [
      { name: "Salud", description: "Estado del servicio" },
      { name: "Cámaras", description: "Alta, consulta y borrado de cámaras" },
      { name: "Imágenes", description: "Fotos puntuales y stream MJPEG" },
      { name: "API keys", description: "Credenciales para terceros" },
    ],
    components: {
      securitySchemes: { bearerAuth, apiKeyAuth: apiKeyHeader },
      schemas: {
        Error: {
          type: "object",
          properties: { error: { type: "string" }, retryAfterSec: { type: "integer" } },
        },
        Camera: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            brand: { type: "string", nullable: true },
            sourceType: { type: "string", enum: ["rtsp", "mjpeg", "onvif", "test"] },
            host: { type: "string" },
            order: { type: "integer" },
            active: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        ApiKey: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            label: { type: "string" },
            scopes: { type: "array", items: { type: "string", enum: [...SCOPES] } },
            rateLimit: { type: "integer", description: "Peticiones por minuto" },
            revoked: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            lastUsedAt: { type: "string", format: "date-time", nullable: true },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
    paths: {
      "/api/auth/status": {
        get: {
          tags: ["Salud"],
          summary: "¿Hay que crear el primer usuario? ¿se puede registrar?",
          security: [],
          responses: { "200": { description: "Estado", content: json({ type: "object" }) } },
        },
      },
      "/api/auth/register": {
        post: {
          tags: ["Salud"],
          summary: "Registrar usuario (el primero es `owner`)",
          security: [],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["email", "password"],
              properties: { email: { type: "string", format: "email" }, password: { type: "string", minLength: 8 } },
            }),
          },
          responses: {
            "201": { description: "JWT", content: json({ type: "object" }) },
            "403": errorResponse,
            "409": errorResponse,
          },
        },
      },
      "/api/auth/login": {
        post: {
          tags: ["Salud"],
          summary: "Login → JWT (10/min por IP)",
          security: [],
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["email", "password"],
              properties: { email: { type: "string", format: "email" }, password: { type: "string" } },
            }),
          },
          responses: {
            "200": { description: "JWT", content: json({ type: "object" }) },
            "401": errorResponse,
            "429": errorResponse,
          },
        },
      },
      [API.health]: {
        get: {
          tags: ["Salud"],
          summary: "Estado del servicio (sin autenticación)",
          security: [],
          responses: { "200": { description: "OK", content: json({ type: "object" }) } },
        },
      },
      [API.cameras]: {
        get: {
          tags: ["Cámaras"],
          summary: "Listar cámaras",
          responses: {
            "200": {
              description: "Cámaras",
              content: json({
                type: "object",
                properties: { cameras: { type: "array", items: { $ref: "#/components/schemas/Camera" } } },
              }),
            },
          },
        },
        post: {
          tags: ["Cámaras"],
          summary: "Crear cámara (sólo JWT)",
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["name", "connection"],
              properties: {
                name: { type: "string" },
                sourceType: { type: "string", enum: ["rtsp", "mjpeg", "onvif", "test"] },
                connection: { type: "string", description: "rtsp://usuario:pass@ip:puerta/ruta" },
                host: { type: "string" },
                order: { type: "integer" },
                active: { type: "boolean" },
              },
            }),
          },
          responses: { "201": { description: "Creada" }, "401": errorResponse, "403": errorResponse },
        },
      },
      [API.camera("{id}")]: {
        get: {
          tags: ["Cámaras"],
          summary: "Detalle de una cámara",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Cámara" }, "404": errorResponse },
        },
        delete: {
          tags: ["Cámaras"],
          summary: "Borrar cámara (sólo JWT)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "Borrada" }, "401": errorResponse },
        },
      },
      "/api/v1/cameras/{id}/frame.jpg": {
        get: {
          tags: ["Imágenes"],
          summary: "Último fotograma en JPEG",
          description:
            "Foto del instante de la petición (no es vídeo). Si nadie está mirando la cámara no hay frames " +
            "recientes y se responde 404: abre la cámara en la app (o pide el stream MJPEG) para que el agent arranque.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              description: "JPEG",
              content: { "image/jpeg": { schema: { type: "string", format: "binary" } } },
            },
            "404": errorResponse,
            "401": errorResponse,
            "429": errorResponse,
          },
        },
      },
      "/api/v1/cameras/thumbnails": {
        get: {
          tags: ["Imágenes"],
          summary: "Miniaturas en Cloudinary (una por cámara)",
          responses: { "200": { description: "URLs de miniaturas" }, "401": errorResponse },
        },
      },
      "/api/v1/cameras/{id}/thumbnail": {
        post: {
          tags: ["Imágenes"],
          summary: "Generar miniatura ahora (sólo JWT)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "URL de Cloudinary" }, "409": errorResponse, "401": errorResponse },
        },
      },
      [API.stream("{id}")]: {
        get: {
          tags: ["Imágenes"],
          summary: "Stream MJPEG continuo (multipart/x-mixed-replace)",
          description:
            "Vídeo para terceros sin WebSocket: basta `<img src=…>` o abrirlo en VLC/ffmpeg. " +
            "Mantiene abierto el stream mientras haya espectadores y lo cierra si llega un fotograma " +
            "reciente en 60 s. Con API key debe tener scope `stream`... scope `read` es suficiente (REST).",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            "200": { description: "MJPEG", content: { "multipart/x-mixed-replace": { schema: { type: "string" } } } },
            "404": errorResponse,
            "401": errorResponse,
            "429": errorResponse,
          },
        },
      },
      [API.keys]: {
        get: {
          tags: ["API keys"],
          summary: "Listar mis API keys (sólo JWT)",
          responses: { "200": { description: "Lista", content: json({ type: "object" }) }, "401": errorResponse },
        },
        post: {
          tags: ["API keys"],
          summary: "Crear API key (sólo JWT de owner)",
          description: "La key en claro (`key`) se devuelve **una sola vez**: sólo se guarda su hash SHA-256.",
          requestBody: {
            required: true,
            content: json({
              type: "object",
              required: ["label"],
              properties: {
                label: { type: "string" },
                scopes: { type: "array", items: { type: "string", enum: [...SCOPES] }, default: ["read", "stream"] },
                rate_limit: { type: "integer", default: 60, description: "Peticiones por minuto" },
              },
            }),
          },
          responses: {
            "201": { description: "Creada (incluye `key`)", content: json({ type: "object" }) },
            "403": errorResponse,
          },
        },
      },
      [API.key("{id}")]: {
        delete: {
          tags: ["API keys"],
          summary: "Revocar API key (sólo JWT de owner)",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "204": { description: "Revocada" }, "404": errorResponse, "403": errorResponse },
        },
      },
    },
  };
}

docsRouter.get(API.openapi, (req, res) => {
  const base = `${req.protocol}://${req.get("host") ?? "localhost"}`;
  res.set("Cache-Control", "public, max-age=300").json(openapi(base));
});

docsRouter.get(API.docs, (req, res) => {
  const base = `${req.protocol}://${req.get("host") ?? "localhost"}`;
  res.set("Content-Type", "text/html; charset=utf-8").send(page(base));
});

const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function row(method: string, path: string, auth: string, what: string): string {
  const cls = method === "GET" ? "get" : method === "POST" ? "post" : "del";
  return `<tr><td><span class="m ${cls}">${method}</span></td><td><code>${esc(path)}</code></td><td>${auth}</td><td>${what}</td></tr>`;
}

function page(base: string): string {
  const rows = [
    row("GET", "/api/health", "—", "Estado del servicio (cámaras, WS, Cloudinary, límites)"),
    row("GET", "/api/v1/cameras", "—", "Listar cámaras"),
    row("POST", "/api/v1/cameras", "JWT", "Crear cámara (la URL RTSP va cifrada)"),
    row("GET", "/api/v1/cameras/:id", "—", "Detalle de una cámara"),
    row("DELETE", "/api/v1/cameras/:id", "JWT", "Borrar cámara"),
    row("GET", "/api/v1/cameras/:id/frame.jpg", "JWT o key", "Último fotograma en JPEG"),
    row("GET", "/api/v1/cameras/thumbnails", "JWT o key", "Miniaturas en Cloudinary"),
    row("POST", "/api/v1/cameras/:id/thumbnail", "JWT", "Generar miniatura ahora"),
    row("GET", "/api/v1/streams/:id.mjpg", "JWT o key", "Stream MJPEG continuo"),
    row("GET", "/api/v1/keys", "JWT", "Listar API keys"),
    row("POST", "/api/v1/keys", "JWT owner", "Crear API key (devuelve la clave una vez)"),
    row("DELETE", "/api/v1/keys/:id", "JWT owner", "Revocar API key"),
  ].join("\n");

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cameras Center · API</title>
<style>
  :root { color-scheme: light dark; --fg:#111827; --muted:#6b7280; --line:#e5e7eb; --bg:#fff;
          --get:#0369a1; --post:#15803d; --del:#b91c1c; --code:#f3f4f6; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e5e7eb; --muted:#9ca3af; --line:#1f2937; --bg:#0b0f19; --code:#111827; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; color:var(--fg); background:var(--bg); }
  .wrap { max-width: 940px; margin: 0 auto; padding: 32px 20px 80px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  h2 { font-size: 18px; margin: 36px 0 10px; padding-top: 18px; border-top: 1px solid var(--line); }
  p.lead { color: var(--muted); margin-top: 0; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
  pre { background: var(--code); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
  code.inline { background: var(--code); padding: 1px 5px; border-radius: 4px; }
  table { width:100%; border-collapse: collapse; margin-top: 8px; }
  th, td { text-align:left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
  .m { display:inline-block; min-width: 56px; text-align:center; font-size:11px; font-weight:700; padding:2px 6px; border-radius:4px; color:#fff; }
  .m.get { background: var(--get); } .m.post { background: var(--post); } .m.del { background: var(--del); }
  a { color: var(--get); }
  .badge { display:inline-block; background:var(--code); border:1px solid var(--line); border-radius:999px; padding:2px 10px; font-size:12px; color:var(--muted); }
  .note { border-left: 3px solid var(--get); padding: 6px 12px; background: var(--code); border-radius: 0 6px 6px 0; }
</style>
</head>
<body><div class="wrap">

<h1>Cameras Center · API</h1>
<p class="lead">Documentación en vivo del servidor. Base actual: <code class="inline">${esc(base)}</code>
· <a href="${API.openapi}">openapi.json</a></p>

<p><span class="badge">JWT</span> <span class="badge">API key</span> <span class="badge">rate limit 429</span> <span class="badge">MJPEG</span> <span class="badge">socket.io</span></p>

<h2>Autenticación</h2>
<p>Dos credenciales, ambas por cabecera:</p>
<pre># Usuario de la app (puede escribir)
Authorization: Bearer &lt;jwt&gt;

# Tercero (sólo lectura; alt. X-API-Key: cc_live_…)
Authorization: Bearer cc_live_&lt;40 hex&gt;
<span style="opacity:.6"># o bien</span>
X-API-Key: cc_live_&lt;40 hex&gt;</pre>
<p>Las API keys se crean con <code class="inline">POST /api/v1/keys</code>; sólo se muestra la clave
<strong>una vez</strong> porque el servidor guarda su hash SHA-256. Scopes: <code class="inline">read</code>
(peticiones REST) y <code class="inline">stream</code> (suscripción WebSocket). Una key sin <code class="inline">read</code>
recibe 403 en cualquier endpoint de lectura.</p>

<h2>Endpoints</h2>
<table>
<thead><tr><th>Método</th><th>Ruta</th><th>Auth</th><th>Qué hace</th></tr></thead>
<tbody>
${rows}
</tbody></table>

<h2>Ejemplos</h2>
<pre># 1. Registrar (sólo la primera vez) y obtener JWT
curl -s -X POST ${base}/api/auth/register \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"yo@ejemplo.com","password":"contraseña-larga"}' | jq -r .token

# 2. Crear una API key para mi app
curl -s -X POST ${base}/api/v1/keys \\
  -H "Authorization: Bearer $TOKEN" \\
  -H 'Content-Type: application/json' \\
  -d '{"label":"mi-app","rate_limit":120}' | jq -r .key

# 3. Consultar cámaras con la key (la lista es pública, pero sirve para probar)
curl -s ${base}/api/v1/cameras -H "X-API-Key: $KEY" | jq '.cameras[].name'

# 4. Descargar un fotograma JPEG
curl -s -o hoy.jpg "${base}/api/v1/cameras/$CAMARA/frame.jpg" -H "X-API-Key: $KEY"

# 5. Ver el stream en un navegador / VLC / ffmpeg
#    (sin SDK: es un <img src>)
ffmpeg -headers "X-API-Key: $KEY" \\
  -i "${base}/api/v1/streams/$CAMARA.mjpg" -frames:v 1 foto.jpg</pre>

<h2>Tiempo real (socket.io)</h2>
<p>Para vídeo en vivo sin abrir y cerrar peticiones, el servidor hace de relé entre el <em>agent</em> de la LAN
y cualquier cliente. El protocolo es <strong>socket.io</strong> sobre la raíz del servidor:</p>
<pre>import { io } from "socket.io-client";

const socket = io("${base}", { auth: { token: process.env.CAM_KEY } }); // JWT o API key (scope stream)

socket.on("connect", () =&gt; {
  socket.emit("viewer:subscribe", { cameraId: "UUID" }, (ack) =&gt; {
    if (!ack.ok) console.warn("No suscrito", ack); // p.ej. { error: 'Límite de peticiones excedido' }
  });
});

// binario: primero la cabecera JSON, después el JPEG
socket.on("stream:frame", (header, jpegBytes) =&gt; {
  // header: { cameraId, seq, fps, width, height }  · seq=-1 => imagen de puesta al día
  render(header, jpegBytes);
});

socket.emit("viewer:unsubscribe", { cameraId });  // al cerrar
// cuidado: no confirmar más de 4 frames en vuelo (MAX_INFLIGHT) o se te saltarán</pre>

<h2>Límites de peticiones</h2>
<p>Cada respuesta trae <code class="inline">X-RateLimit-Limit</code>, <code class="inline">X-RateLimit-Remaining</code>
y <code class="inline">X-RateLimit-Reset</code>. Si te pasas, la respuesta es <strong>429</strong> con
<code class="inline">Retry-After</code>:</p>
<pre>HTTP/1.1 429 Too Many Requests
Retry-After: 41
X-RateLimit-Limit: 120
X-RateLimit-Remaining: 0

{"error":"Límite de peticiones excedido (120/min en esta API key)","retryAfterSec":41}</pre>
<p class="note">Ventana fija de 60 s. Por IP: <code class="inline">RATE_LIMIT_RPM</code> (300/min).
Por API key: su <code class="inline">rate_limit</code> (60/min por defecto).
Login/registro: 10/min por IP (<code class="inline">AUTH_RATE_LIMIT_RPM</code>).</p>

<h2>Errores</h2>
<table>
<tbody>
<tr><td><code>401</code></td><td>Credencial ausente, inválida, expirada o revocada</td></tr>
<tr><td><code>403</code></td><td>Credencial válida sin permiso (scope o rol <code>owner</code>)</td></tr>
<tr><td><code>404</code></td><td>Recurso inexistente — o <em>sin frames recientes</em> en <code>frame.jpg</code></td></tr>
<tr><td><code>409</code></td><td>Conflicto (ya existe, miniatura en curso…)</td></tr>
<tr><td><code>429</code></td><td>Límite de peticiones agotado</td></tr>
<tr><td><code>503</code></td><td>Servicio no configurado (p.ej. sin Cloudinary)</td></tr>
</tbody></table>

<p style="margin-top:36px;color:var(--muted);font-size:13px">Generado por Cameras Center ·
<a href="${API.openapi}">spec OpenAPI</a></p>
</div></body></html>`;
}
