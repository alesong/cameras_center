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

| Servicio | URL |
|---|---|
| Web (Vite) | http://localhost:5173 |
| API server | http://localhost:4000/api/health |
| API cámaras | http://localhost:4000/api/v1/cameras |
| Stream MJPEG (agent) | http://localhost:4100/stream/{id}.mjpg |

## Comandos

| Comando | Descripción |
|---|---|
| `npm run dev` | Levanta server + agent + web en paralelo |
| `npm run discover` | Barre la red local buscando cámaras (RTSP/HTTP/ONVIF) |
| `npm run typecheck` | `tsc --noEmit` sobre todo el monorepo |
| `npm run build` | Compila todos los workspaces |
| `npm run start` | Arranca el server compilado (producción en Render) |

## Roadmap

| Fase | Objetivo | Estado |
|---|---|---|
| **F0** | Monorepo, tipos compartidos, apps mínimas funcionando | ✅ en curso |
| **F1** | Agent lee 1 cámara RTSP y se ve en el navegador | ⬜ |
| **F2** | Supabase + auth JWT + agent autenticado contra el server | ⬜ |
| **F3** | Relay agent → server → web remoto (multi-cámara) | ⬜ |
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
