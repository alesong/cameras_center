# Cámaras comprobadas

Registro de lo que ha funcionado **de verdad**, para no volver a investigarlo.

---

## O-KAM (marca EZVIZ / O-KAM Pro) — ✅ funcionando

| Dato | Valor |
|---|---|
| IP | `192.168.18.36` (red de desarrollo) |
| Puertos abiertos | **sólo `10554`** (sin HTTP, sin ONVIF, sin 554) |
| Protocolo | RTSP con autenticación **Digest** (`realm="RTSPD"`) |
| Usuario | `admin` |
| Ruta válida | **`/tcp/av0_0`** |
| Stream | H.264, **2304×1296**, **15 fps** |

URL registrada en la app:

```
rtsp://admin:<password>@192.168.18.36:10554/tcp/av0_0
```

### Cómo se habilitó

RTSP/ONVIF viene **desactivado de fábrica**. Hay que activarlo en la app del
fabricante y ahí se crea la contraseña de acceso. Una vez activo, aparece el
puerto `10554`.

### Errores que costaron tiempo (y ya están corregidos)

1. **`OPTIONS rtsp://…/ ` no contesta.** Esta cámara ignora `OPTIONS` y cierra
   el socket ⇒ `tools/lan-scan.mjs` decía *"no habla RTSP"* siendo falso.
   La sonda ahora envía **`DESCRIBE`** y prueba varias rutas.
2. **`DESCRIBE rtsp://…:10554/` (raíz) tampoco contesta.** Sólo responde en
   rutas reales (`/tcp/av0_0`). Por eso la sonda prueba
   `/tcp/av0_0`, `/`, `/live`, `/Streaming/Channels/101`, `/h264_preview_01`.
3. **Un `401 Unauthorized` ES una respuesta positiva**: significa que hay un
   servidor RTSP vivo pidiendo credenciales (no es un "deshabilitado").
4. **ffprobe no estaba en el PATH** (FFmpeg instalado con winget). El scan ahora
   lo busca en `PATH` y en `%LOCALAPPDATA%\Microsoft\WinGet\Packages`.

Verificación:

```bash
npm run discover -- --ip 192.168.18.36 --user admin --pass <password>
#   RTSP 10554: OK (RTSP/1.0 401 Unauthorized) en /tcp/av0_0
#   rtsp://admin:***@192.168.18.36:10554/tcp/av0_0 -> h264,2304,1296,15/1
```

### Resultado con el pipeline real

```
snapshot   24.7 KB, JPEG válido (FF D8 FF)
stream     multipart/x-mixed-replace, 44 frames en 5,2 s (~6-8 fps, objetivo 6)
pipeline   state=running, online=true, fps=6, bitrate=1215 kbps
```

Las credenciales **no aparecen en ningún log** (`redactUrl`/`redactSecrets`)
ni en la BD (`connection_encrypted` en formato `v1.…`, AES-256-GCM).

---

## Cámara O-KAM (versión anterior, con RTSP desactivado) — ❌

Con RTSP sin habilitar, la barredura completa de puertos `1-65535` dio **sólo
`9001` y `9002`** (protocolo P2P propietario de Ai-Link / Sichuan AI-Link,
MAC `18-ef-3a`). Sin HTTP, sin RTSP, sin ONVIF y sin respuesta a WS-Discovery:
**no hay por dónde colarse**, hay que activarlo en la app.

---

## URLs RTSP útiles por marca (para las EZVIZ de la otra red)

| Marca | Puerto | Rutas |
|---|---|---|
| EZVIZ / Hikvision | 554 o **10554** | `/Streaming/Channels/101` (principal) · `/102` (sub) |
| EZVIZ variantes | 10554 | `/tcp/av0_0` · `/h264_preview_01` |
| Genéricas | 554 | `/live` · `/live/ch00_0` |
| Dahua / ONVIF | 554 | `/cam/realmonitor?channel=1&subtype=0` |

ONVIF: `http://<ip>/onvif/device_service` (requisito: puerto 80 abierto).

> En las EZVIZ el RTSP hay que **activarlo también en la app** (configuración →
> red/avanzado → RTSP o "protocolo de stream"), y allí se fija la contraseña.
