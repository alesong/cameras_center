# Guía de instalación — Ubuntu 24.04 (PC de pruebas)

Este documento deja el monorepo **cameras-center** corriendo en un PC con Ubuntu 24.04,
listo para probar con cámaras **EZVIZ** reales de la red local.

---

## 1. Requisitos

| Componente | Versión mínima | Comprobar |
|---|---|---|
| Node.js | 20+ (recomendado 22 LTS) | `node -v` |
| npm | 9+ | `npm -v` |
| FFmpeg | 5+ | `ffmpeg -version` |
| git, build-essential | — | `git --version` |

Ubuntu 24.04 trae Node 18 en `apt`, que **no vale**. Instala Node 22 con NodeSource:

```bash
sudo apt update
sudo apt install -y git curl ca-certificates build-essential

# Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# FFmpeg
sudo apt install -y ffmpeg

node -v && npm -v && ffmpeg -version
```

Alternativa con `nvm` (sin sudo):

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 22
```

---

## 2. Copiar el proyecto

```bash
mkdir -p ~/dev && cd ~/dev

# Opción A: desde git (recomendado)
git clone <tu-repositorio> "cameras center"
cd "cameras center"

# Opción B: copia directa desde el PC Windows
# rsync -av "/c/Datos 2T/appsNode/cameras center/" usuario@ubuntu:~/dev/"cameras center" --exclude node_modules
```

**Importante:** `.env` está en `.gitignore` y no viaja con el repositorio:

```bash
cp .env.example .env
nano .env      # completa los valores (ver sección 3)
```

---

## 3. Variables de entorno mínimas

```dotenv
PORT=4000
CORS_ORIGIN=http://localhost:5173
SERVER_WSS_URL=http://localhost:4000

JWT_SECRET=<64 hex aleatorios>        # openssl rand -hex 32
CAMERA_ENC_KEY=<64 hex aleatorios>    # openssl rand -hex 32

AGENT_TOKEN=<token compartido>        # mismo valor en server y agent
AGENT_STREAM_PORT=4100
AGENT_NO_VIEWER_STOP_MS=60000

VITE_SERVER_URL=http://localhost:4000
# Para verlo desde otros dispositivos de la LAN usa la IP del PC Ubuntu:
VITE_AGENT_URL=http://<IP-DEL-PC>:4100
```

---

## 4. Red (crítico para que las cámaras funcionen)

1. **IP fija o reserva DHCP** para el PC Ubuntu y para cada cámara (en el router).
2. **Misma subred** que las cámaras. Comprueba:

   ```bash
   ip -4 addr show          # IP del PC
   ip route                 # gateway / subred
   ```

3. **Wi-Fi:** si las cámaras están por Wi-Fi, desactiva el *aislamiento de clientes
   (AP/client isolation)* y la red de invitados: bloquean RTSP entre dispositivos.
4. **Firewall:** sólo abre los puertos a la LAN local:

   ```bash
   sudo ufw allow from 192.168.18.0/24 to any port 22 proto tcp
   sudo ufw allow from 192.168.18.0/24 to any port 4000 proto tcp
   sudo ufw allow from 192.168.18.0/24 to any port 4100 proto tcp
   sudo ufw enable
   ```

   ⚠️ El puerto **4100 nunca debe exponerse a internet**: es el stream MJPEG sin autenticar.

---

## 5. Instalar y arrancar

```bash
cd ~/dev/"cameras center"
npm install
npm run typecheck     # debe terminar sin errores
npm run dev           # server :4000 · agent :4100 · web :5173
```

Verificación:

```bash
curl -s localhost:4000/api/health
curl -s localhost:4100/api/health
curl -s localhost:4000/api/v1/cameras
```

| Servicio | URL |
|---|---|
| UI | http://localhost:5173 |
| API | http://localhost:4000/api/v1/cameras |
| Stream MJPEG local | http://localhost:4100/stream/{id}.mjpg |

---

## 6. Cámaras EZVIZ — puesta en marcha

### 6.1 Credenciales

- **Usuario:** `admin` (por defecto en EZVIZ).
- **Contraseña:**
  - la que configuraste en la app **EZVIZ** al dar de alta el dispositivo, o
  - el **código de verificación / encryption code** de 8 caracteres impreso en la
    etiqueta del dispositivo (algunos modelos lo usan como contraseña RTSP por defecto).

### 6.2 RTSP está deshabilitado de fábrica (muy habitual)

Si `ffprobe` no conecta, hay que habilitarlo:

1. App **EZVIZ** → dispositivo → ⚙️ *Configuración* → *Más ajustes* / *Ajustes de red*
   → busca **RTSP**, **ONVIF** o **"contraseña en texto plano"** (*plaintext password*)
   y actívalo.
2. En modelos con web local: abre `http://<ip-de-la-camara>` e inicia sesión con el
   código de verificación → *Red* → *Servicios* → habilita RTSP/ONVIF.
3. Reinicia la cámara si no aparece el cambio.

### 6.3 URLs candidatas (puerto 554)

```
rtsp://admin:<pass>@<ip>:554/Streaming/Channels/101     # stream principal (H.265)
rtsp://admin:<pass>@<ip>:554/Streaming/Channels/102     # sub-stream (menor bitrate)
rtsp://admin:<pass>@<ip>:554/h264_preview_01            # variante EZVIZ/Hikvision
rtsp://<ip>:554/live                                    # genérica
```

> Usa **102** (sub-stream) para el acceso remoto: menos ancho de banda. El **101**
> principal sirve para visualización local en alta.

### 6.4 Descubrimiento automático

```bash
# Barre la subred y sondea RTSP/HTTP
npm run discover -- --subnet 192.168.18.0/24

# Con credenciales: prueba las URLs candidatas con ffprobe
npm run discover -- --subnet 192.168.18.0/24 --user admin --pass "MiPassword"
```

### 6.5 Prueba manual con FFmpeg

```bash
# ¿Contesta la cámara?
ffprobe -rtsp_transport tcp -v warning \
  -i "rtsp://admin:MIPASS@192.168.18.36:554/Streaming/Channels/102"

# Grabar 5 segundos para validar el flujo
ffmpeg -rtsp_transport tcp -i "rtsp://admin:MIPASS@192.168.18.36:554/Streaming/Channels/102" \
  -t 5 -c copy /tmp/prueba.mp4 && ffprobe /tmp/prueba.mp4
```

Si `ffprobe` devuelve `codec_name=h264|h265` y resolución, la cámara está lista.

### 6.6 Añadirla al proyecto

1. Abre la UI → *Añadir cámara* → tipo **RTSP** → pega la URL.
2. En la tarjeta aparece **▶ ver en vivo** (el agent arranca FFmpeg bajo demanda).
3. `Capturar` devuelve un JPEG del último frame: `http://<IP-PC>:4100/snapshot/{id}.jpg`

---

## 7. Dejarlo corriendo (systemd)

`/etc/systemd/system/cameras-agent.service`:

```ini
[Unit]
Description=Cameras Center agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=%i
WorkingDirectory=/home/%i/dev/cameras center
EnvironmentFile=/home/%i/dev/cameras center/.env
ExecStart=/usr/bin/npm run dev -w @cameras/agent
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cameras-agent
journalctl -u cameras-agent -f
```

Repite el proceso para `@cameras/server` si quieres la API disponible sin `npm run dev`.

---

## 8. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| `ffprobe` timeout con la IP | RTSP deshabilitado | Habilitar RTSP/ONVIF en la app (6.2) |
| Conecta pero sin video | Contraseña incorrecta | Probar con el código de verificación de la etiqueta |
| `Connection refused` en 554 | Puerto distinto o cerrado | `npm run discover -- --ip <ip>` para ver puertos reales |
| Solo funciona el PC con cable | Aislamiento de clientes Wi-Fi | Desactivarlo en el router |
| La UI muestra "Sin señal" | El agent no está corriendo o `VITE_AGENT_URL` apunta a `localhost` | Usar la IP del PC en `VITE_AGENT_URL` |
| FFmpeg no encontrado | `ffmpeg` fuera del PATH | `sudo apt install ffmpeg` o `FFMPEG_PATH=/usr/bin/ffmpeg` |
| Latencia alta | Transcodificación a 6 fps | Subir `fps` en `apps/agent/src/pipeline/args.ts` |

---

## 9. Siguientes pasos

- **F2**: Supabase (cámaras persistentes) + JWT + token de agent firmado.
- **F3**: relay agent → server (Render) para ver las cámaras fuera de casa.
- **F4**: descubrimiento ONVIF real + thumbnails en Cloudinary.
