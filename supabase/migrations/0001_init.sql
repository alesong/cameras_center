-- ===========================================================================
-- Cameras Center — esquema inicial (F2)
-- Ejecutar en: Supabase Dashboard → SQL Editor → New query → Run
-- ===========================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Usuarios
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  role          text not null default 'owner' check (role in ('owner','viewer')),
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Cámaras
--   connection_encrypted: URL RTSP/MJPEG cifrada con AES-256-GCM (CAMERA_ENC_KEY)
--   Nunca se guarda en claro y jamás se expone en la API pública.
-- ---------------------------------------------------------------------------
create table if not exists public.cameras (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null check (char_length(name) between 1 and 80),
  brand                text,
  source_type          text not null default 'rtsp'
                             check (source_type in ('rtsp','mjpeg','onvif','test')),
  host                 text not null,
  connection_encrypted text,
  sort_order           integer not null default 0,
  active               boolean not null default true,
  owner_id             uuid references public.users(id) on delete set null,
  created_at           timestamptz not null default now()
);

create index if not exists cameras_sort_idx on public.cameras (sort_order, name);

-- ---------------------------------------------------------------------------
-- API keys (F5): se guarda sólo el hash
-- ---------------------------------------------------------------------------
create table if not exists public.api_keys (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  key_hash    text not null unique,
  scopes      text[] not null default '{read}',
  rate_limit  integer not null default 60,
  owner_id    uuid references public.users(id) on delete cascade,
  revoked_at  timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Eventos / snapshots (F6)
-- ---------------------------------------------------------------------------
create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  camera_id     uuid references public.cameras(id) on delete cascade,
  type          text not null default 'motion',
  thumbnail_url text,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists events_camera_idx on public.events (camera_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Agentes autorizados (token en hash)
-- ---------------------------------------------------------------------------
create table if not exists public.agent_tokens (
  id         uuid primary key default gen_random_uuid(),
  agent_id   text not null unique,
  token_hash text not null,
  last_seen  timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Seguridad: RLS activo. El server usa la service_role key, que BYPASSA RLS.
-- Así la anon/publishable key NO puede leer nada (ni las URLs de cámara).
-- ---------------------------------------------------------------------------
alter table public.users        enable row level security;
alter table public.cameras      enable row level security;
alter table public.api_keys     enable row level security;
alter table public.events       enable row level security;
alter table public.agent_tokens enable row level security;

-- Sin políticas: sólo el service_role (bypass) tiene acceso desde el server.
