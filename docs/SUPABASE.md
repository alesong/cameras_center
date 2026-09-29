# Supabase (F2) — base de datos de Cameras Center

Guarda **sólo metadata**: usuarios, cámaras (URL cifrada), API keys (hash) y eventos.
Nunca video.

## URL que debes usar

Pegaste:

```
https://koakhscqmprmqqtlytdg.supabase.co/rest/v1/cameras-center
```

La base del proyecto es `https://koakhscqmprmqqtlytdg.supabase.co`.
El cliente añade `/rest/v1/<tabla>` por ti, así que en `.env` va **sólo la base**:

```env
SUPABASE_URL=https://koakhscqmprmqqtlytdg.supabase.co
SUPABASE_SERVICE_KEY=        # ← lo único que falta
SUPABASE_SCHEMA=public
```

Comprobado desde aquí: el proyecto responde (PostgREST devuelve `401 No API key found`),
es decir, **el proyecto está vivo y accesible**. Falta únicamente la key.

## Pasos (5 minutos)

1. **SQL**: Supabase Dashboard → *SQL Editor* → *New query* → pega el contenido de
   [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql) → *Run*.
   Verás `Success. No rows returned`.
2. **Key**: *Project Settings* → *API* → copia **`service_role`** (`sb_secret_…` o `eyJ…`).
   ⚠️ No la *anon/publishable* (`sb_publishable_…`): ésta no puede escribir.
3. **Pégala en `.env`**:

   ```env
   SUPABASE_SERVICE_KEY=sb_secret_...
   ```

4. **Reinicia** el server (`npm run dev`). El banner pasa de
   `storage memory (sin SUPABASE_SERVICE_KEY)` a `storage supabase`.

## Comprobación

```bash
curl http://localhost:4000/api/health
#   "storage": { "cameras": "supabase", "supabase": "configured" }
```

Crea una cámara desde la UI y recárgala: debe seguir ahí tras reiniciar el server
(antes se perdía al ser memoria).

## Seguridad

- La **service_role key nunca sale del server** ni se mete en el bundle de Vite.
- Las tablas tienen **RLS activo y sin políticas**: sólo el `service_role`
  (que hace *bypass*) puede leerlas. La anon key no ve ni las URLs de cámara.
- Las URLs RTSP se guardan en `cameras.connection_encrypted` cifradas con
  **AES-256-GCM** (`CAMERA_ENC_KEY`) y **nunca** aparecen en `/api/v1/cameras`;
  sólo las recibe `/api/agent/cameras` (con `x-agent-token`).

## Si no quieres Supabase todavía

Sin key, el server arranca igualmente en **modo memoria** (`storage: memory`):
todo funciona, pero las cámaras y usuarios se pierden al reiniciar. Útil para
desarrollar o para probar con la O-KAM sin tocar nada.

## Registro de usuarios

- El **primer** usuario registrado queda como `owner`.
- Después, `ALLOW_REGISTER=false` en `.env` cierra el registro (sólo login).

## Autenticación

| Endpoint | Body | Devuelve |
|---|---|---|
| `GET /api/auth/status` | – | `needsSetup`, `allowRegister`, `backend` |
| `POST /api/auth/register` | `{email, password≥8}` | `201 {token, user}` |
| `POST /api/auth/login` | `{email, password}` | `200 {token, user}` |
| `GET /api/auth/me` | `Authorization: Bearer <token>` | `200` / `401` |

JWT HS256 firmado con `JWT_SECRET`, caduca en 7 días. Las contraseñas se guardan
con **scrypt** (`node:crypto`, sin dependencias).

`POST /api/v1/cameras` y `DELETE /api/v1/cameras/:id` **exigen** token;
`GET /api/v1/cameras` sigue siendo público (la UI y los viewers lo necesitan).

## API pública (F5)

Las API keys de terceros se guardarán en `api_keys` como **hash** (nunca en claro)
junto a `scopes` y `rate_limit`; el plaintext sólo se muestra una vez al crearla.
