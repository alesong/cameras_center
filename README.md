# Cameras Center

Monorepo para ver cámaras IP de la red local en vivo desde el navegador, exponer ese
stream y sus metadatos vía API para que otras aplicaciones lo consuman.

```
[Cámaras RTSP/ONVIF] ──► AGENT (LAN) ──┬──► web local    (baja latencia)
                                       │
                                       └──► SERVER (Render) ◄── web remoto (Vercel)
                                                 │
                                                 └──► API pública (REST + WS)
```

## Estructura

```
apps/
  agent/     Daemon edge. Corre en una máquina de la LAN: descubre cámaras,
             lee RTSP, transcodifica y hace push al server. (Node + FFmpeg)
  server/    API REST + WebSocket. Registro, auth, relay de streams. (Render)
  web/       UI. Grid de cámaras en vivo y panel de administración. (Vercel)
packages/
  protocol/  Tipos + esquemas Zod compartidos (contrato de mensajes).
  core/      Utilidades: cifrado de credenciales, parsing RTSP, API keys.
  ui/        Componentes React reutilizables (grid, tarjeta, badges).
```

## Requisitos

- Node.js >= 20
- npm >= 9 (workspaces)
- FFmpeg en el PATH (solo para el agent, a partir de F1): `ffmpeg -version`

## Puesta en marcha

```bash
cp .env.example .env      # completa los valores
npm install
npm run typecheck         # valida todo el monorepo
npm run dev               # server :4000 · agent :4100 · web :5173
```

> 📄 **PC con Ubuntu 24.04 + cámaras EZVIZ:** ver la guía completa en
> [`docs/UBUNTU.md`](docs/UBUNTU.md) (instalación, red, URLs RTSP, systemd).
>
> 📷 **Cámara ya comprobada (O-KAM/EZVIZ, RTSP :10554 `/tcp/av0_0`):**
> [`docs/CAMARAS-COMPROBADAS.md`](docs/CAMARAS-COMPROBADAS.md).
>
> 🗄 **Supabase (auth + persistencia):** [`docs/SUPABASE.md`](docs/SUPABASE.md).

| Servicio | URL |
|---|---|
| Web (Vite) | http://localhost:5173 |
| API server | http://localhost:4000/api/health |
| API cámaras | http://localhost:4000/api/v1/cameras |
| Stream MJPEG (agent) | http://localhost:4100/stream/{id}.mjpg |

## Autenticación (F2)

```bash
# primer usuario (queda como owner)
curl -X POST http://localhost:4000/api/auth/register \
  -H 'content-type: application/json' -d '{"email":"yo@local","password":"<tu-password>"}'
# → {"token":"eyJ..."}

# crear cámara (exige token)
curl -X POST http://localhost:4000/api/v1/cameras \
  -H 'content-type: application/json' -H 'authorization: Bearer $TOKEN' \
  -d '{"name":"Entrada","sourceType":"rtsp","connection":"rtsp://admin:pass@192.168.1.10:554/..."}'
```

`GET /api/v1/cameras` es público y **no incluye** la URL de conexión; la recibe
sólo el agent (`/api/agent/cameras`, cabecera `x-agent-token`).

- Sin `SUPABASE_SERVICE_KEY`, el server arranca en **modo memoria** (todo funciona,
  pero nada persiste). Setup completo: [`docs/SUPABASE.md`](docs/SUPABASE.md).
- SQL inicial: [`supabase/migrations/0001_init.sql`](supabase/migrations/0001_init.sql).

## Cómo llega la imagen al navegador (F3)

Hay dos caminos y la app elige el primero que funcione:

```
(1) LAN (rápido)      navegador ──HTTP MJPEG──► agent :4100 ──► FFmpeg ──► cámara
(2) Relay (remoto)    navegador ──WS──► server ──WS──► agent ──► FFmpeg ──► cámara
                       (JWT)           (JWT)            (AGENT_TOKEN)
```

1. **Directo**: el `<img>` apunta a `VITE_AGENT_URL` (sólo funciona en la LAN).
2. Si esa imagen falla, la tarjeta **cambia sola a `🌐 Servidor`**: se suscribe
   por WebSocket al server, éste le pide al agent que arranque FFmpeg y reenvía
   cada JPEG por `stream:frame` (binario). También se cambia a mano con el
   botón de cada tarjeta.

Detalles que importan:

- **Sólo hay relay si alguien mira.** Al suscribirse llega `server:startStream`
  al agent; al dejar de mirar, `server:stopStream` → el agent se desprende y
  FFmpeg se apaga a los `AGENT_NO_VIEWER_STOP_MS` sin espectadores.
- **Backpressure**: el server manda los frames con *ack*; si un cliente va lento
  (más de 4 sin confirmar) se le **saltan** frames en vez de encolarlos. El agent
  además emite con `socket.volatile`: si la subida se satura, se descarta.
- **Rate**: `RELAY_FPS` (por defecto 6) limita lo que sube por la WAN.
- **Auth**: el WS valida en el handshake (`auth.token` = AGENT_TOKEN para el
  agent, JWT para los espectadores) y rechaza todo lo demás.
- **`GET /api/v1/cameras/:id/frame.jpg`** (JWT) devuelve el último JPEG: fallback
  para quien no pueda abrir WebSocket y base de F5/F6.
- Al suscribirse llega primero el último frame cacheado con `seq: -1`
  ("puesta al día") para no dejar pantalla negra.

```bash
npm run test:relay     # 26 comprobaciones; necesita server + agent levantados
```

## Comandos

| Comando | Descripción |
|---|---|
| `npm run dev` | Levanta server + agent + web en paralelo |
| `npm run discover` | Barre la red local buscando cámaras (RTSP/HTTP/ONVIF) |
| `npm run typecheck` | `tsc --noEmit` sobre todo el monorepo |
| `npm run build` | Compila todos los workspaces |
| `npm run start` | Arranca el server compilado (producción en Render) |
| `npm run db:ping` | Comprueba credenciales Supabase y tablas |
| `npm run test:relay` | F3: simula un espectador remoto y valida el relay |

## Roadmap

| Fase | Objetivo | Estado |
|---|---|---|
| **F0** | Monorepo, tipos compartidos, apps mínimas funcionando | ✅ |
| **F1** | Agent lee 1 cámara RTSP y se ve en el navegador | ✅ |
| **F2** | Supabase + auth JWT + agent autenticado contra el server | ✅ |
| **F3** | Relay agent → server → web remoto (multi-cámara) | ✅ |
| **F4** | Descubrimiento ONVIF + health + thumbnails en Cloudinary | ⬜ |
| **F5** | API pública con API keys, docs y rate limits | ⬜ |
| **F6** | Detección de movimiento + snapshots + webhooks | ⬜ |
| **F7** | Grabación local de clips por eventos | ⬜ |

## Decisiones de diseño

- **Los navegadores no reproducen RTSP**: siempre pasa por el agent (FFmpeg).
- **El server en Render nunca ve las cámaras** (están en una LAN privada); el video
  sólo viaja de salida desde el agent hacia el server.
- **On-demand**: el agent sólo transcodifica una cámara cuando alguien la está mirando
  y la apaga a los 60 s sin espectadores.
- **Cloudinary** sólo para imágenes/clips cortos. El video en vivo nunca pasa por Cloudinary.
- **Supabase** guarda metadata (cámaras, usuarios, API keys, eventos), nunca video.
