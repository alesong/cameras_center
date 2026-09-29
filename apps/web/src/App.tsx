import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { CreateCameraSchema, type Camera, type CreateCameraInput } from "@cameras/protocol";
import { CameraGrid } from "@cameras/ui";
import { api, getToken, setToken, type HealthResponse } from "./api";
import { AuthScreen } from "./AuthScreen";
import { KeysPanel } from "./KeysPanel";
import { useRelayFrames } from "./useRelayFrames";

/** Fuente de cada cámara: `lan` = MJPEG directo del agent; `relay` = vía server (WS). */
type SourceMode = "lan" | "relay";

export function App() {
  const [authed, setAuthed] = useState(() => Boolean(getToken()));
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(true);

  const [name, setName] = useState("");
  const [connection, setConnection] = useState("");
  const [sourceType, setSourceType] = useState<CreateCameraInput["sourceType"]>("rtsp");

  /** URL base del servidor de streams MJPEG del agent (visión en LAN). */
  const agentUrl = (import.meta.env.VITE_AGENT_URL as string | undefined) ?? "http://localhost:4100";

  // --- F3: origen de cada imagen ------------------------------------------
  // Por defecto se intenta el directo del agent (más rápido, sin pasar por el
  // server). Si falla (estamos fuera de la LAN) se cambia automáticamente al
  // relay por WebSocket: agent → server → navegador.
  const [sourceModes, setSourceModes] = useState<Record<string, SourceMode>>({});
  const sourceOf = (cameraId: string): SourceMode => sourceModes[cameraId] ?? "lan";

  const relayIds = useMemo(
    () => (live ? cameras.filter((c) => sourceOf(c.id) === "relay").map((c) => c.id) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cameras, live, sourceModes],
  );
  const relayUrls = useRelayFrames(relayIds);

  const streamUrls: Record<string, string | undefined> = {};
  if (live) {
    for (const camera of cameras) {
      streamUrls[camera.id] =
        sourceOf(camera.id) === "relay" ? relayUrls[camera.id] : `${agentUrl}/stream/${camera.id}.mjpg`;
    }
  }

  const handleStreamError = useCallback((cameraId: string) => {
    setSourceModes((prev) => (prev[cameraId] === "lan" ? { ...prev, [cameraId]: "relay" } : prev));
  }, []);

  const toggleSource = (cameraId: string) => {
    setSourceModes((prev) => ({
      ...prev,
      [cameraId]: (prev[cameraId] ?? "lan") === "lan" ? "relay" : "lan",
    }));
  };

  const refresh = useCallback(async () => {
    try {
      const [healthData, cameraList, thumbList] = await Promise.all([
        api.health(),
        api.listCameras(),
        // las thumbnails son opcionales: si fallan, la app sigue funcionando
        api.thumbnails().catch(() => ({}) as Record<string, string>),
      ]);
      setHealth(healthData);
      setCameras(cameraList);
      setThumbnails(thumbList);
      setOffline(false);
      setError(null);
    } catch (err) {
      setOffline(true);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refresh();
    const id = setInterval(() => void refresh(), 15000);
    return () => clearInterval(id);
  }, [authed, refresh]);

  if (!authed) {
    return (
      <AuthScreen
        onAuthenticated={() => {
          setAuthed(true);
          setError(null);
        }}
      />
    );
  }

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload = CreateCameraSchema.parse({ name, connection, sourceType });
      await api.createCamera(payload);
      setName("");
      setConnection("");
      setSourceType("rtsp");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if ((err as { status?: number }).status === 401) setAuthed(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(camera: Camera) {
    if (!confirm(`¿Eliminar "${camera.name}"?`)) return;
    try {
      await api.deleteCamera(camera.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if ((err as { status?: number }).status === 401) setAuthed(false);
    }
  }

  /**
   * F4: pide al server que suba el último frame a Cloudinary y abre la imagen.
   * Si no puede (sin frame, sin CLOUDINARY_URL…), cae al snapshot directo del
   * agent — que sólo funciona en la LAN.
   */
  async function handleCapture(camera: Camera) {
    try {
      const url = await api.captureThumbnail(camera.id);
      setThumbnails((prev) => ({ ...prev, [camera.id]: url }));
      window.open(url, "_blank", "noopener");
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 401) {
        setAuthed(false);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (sourceOf(camera.id) === "lan") {
        window.open(`${agentUrl}/snapshot/${camera.id}.jpg`, "_blank", "noopener");
        setError(`Thumbnail del server no disponible (${message}); se abrió el snapshot directo del agent.`);
      } else {
        setError(message);
      }
    }
  }

  function logout() {
    setToken(null);
    setAuthed(false);
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Cameras Center
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <div className={`server-pill ${offline ? "error" : health ? "ok" : ""}`}>
            {offline
              ? "server desconectado"
              : health
                ? `server v${health.version} · ${health.storage?.cameras ?? "?"} · uptime ${health.uptimeSec}s`
                : "conectando…"}
          </div>
          <button className="ghost" type="button" onClick={logout}>
            Salir
          </button>
        </div>
      </header>

      {error && <div className="error-banner">{error}</div>}

      <h2 className="section-title">Añadir cámara</h2>
      <form className="card-panel form-grid" onSubmit={handleAdd}>
        <label>
          Nombre
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Entrada principal"
            required
          />
        </label>
        <label>
          Tipo de origen
          <select value={sourceType} onChange={(e) => setSourceType(e.target.value as typeof sourceType)}>
            <option value="rtsp">RTSP (mayoría de cámaras IP)</option>
            <option value="mjpeg">MJPEG por HTTP</option>
            <option value="test">Test (fuente sintética)</option>
          </select>
        </label>
        <label>
          URL de conexión
          <input
            value={connection}
            onChange={(e) => setConnection(e.target.value)}
            placeholder="rtsp://admin:pass@192.168.1.10:554/Streaming/Channels/101"
            required
          />
        </label>
        <button type="submit" disabled={busy}>
          {busy ? "Guardando…" : "Agregar"}
        </button>
      </form>

      <div className="toolbar">
        <h2 className="section-title" style={{ margin: 0 }}>
          Cámaras ({cameras.length})
        </h2>
        <div className="toolbar-actions">
          <button className="ghost" type="button" onClick={() => setLive((v) => !v)}>
            {live ? "⏸ Pausar en vivo" : "▶ Ver en vivo"}
          </button>
          <button className="ghost" type="button" onClick={() => void refresh()}>
            ⟳ Actualizar
          </button>
        </div>
      </div>

      <CameraGrid
        cameras={cameras}
        streamUrls={streamUrls}
        thumbnails={thumbnails}
        onStreamError={handleStreamError}
        actions={(camera) => (
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button
              className="ghost"
              type="button"
              title={sourceOf(camera.id) === "lan" ? "Directo desde el agent (LAN)" : "Vía server por WebSocket"}
              onClick={(e) => {
                e.stopPropagation();
                toggleSource(camera.id);
              }}
            >
              {sourceOf(camera.id) === "lan" ? "📡 LAN" : "🌐 Servidor"}
            </button>
            <button
              className="ghost"
              type="button"
              title="Sube el último frame a Cloudinary y lo abre"
              onClick={(e) => {
                e.stopPropagation();
                void handleCapture(camera);
              }}
            >
              📸 Capturar
            </button>
            <button
              className="ghost"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleDelete(camera);
              }}
            >
              Eliminar
            </button>
          </div>
        )}
      />

      <KeysPanel
        onAuthLost={() => {
          setAuthed(false);
          setError(null);
        }}
      />

      <h2 className="section-title">Estado</h2>
      <div className="card-panel hint">
        <p style={{ marginTop: 0 }}>
          <strong>Almacenamiento de cámaras:</strong> {health?.storage?.cameras ?? "…"} ·{" "}
          <strong>Supabase:</strong> {health?.storage?.supabase ?? "…"}
        </p>
        <p>
          <strong>Cloudinary:</strong> {health?.cloudinary ? `${health.cloudinary.status} · ${health.cloudinary.thumbnails} miniaturas · ${health.cloudinary.uploads} subidas` : "…"} ·{" "}
          <strong>Conexiones:</strong>{" "}
          {health?.ws
            ? `${health.ws.agents} agent · ${health.ws.viewers} espectadores${health.ws.http ? ` (${health.ws.http} por MJPEG)` : ""}`
            : "…"}
        </p>
        <p>
          <strong>API keys:</strong>{" "}
          {health?.apiKeys
            ? `${health.apiKeys.backend} · ${health.apiKeys.active ?? 0} activas de ${health.apiKeys.total ?? 0}`
            : "…"}{" "}
          · <strong>Límites:</strong>{" "}
          {health?.rateLimit
            ? `${health.rateLimit.global.rpm}/min por IP · ${health.rateLimit.principal.blocked ?? 0} peticiones 429`
            : "…"}{" "}
          · <strong>Docs:</strong>{" "}
          <a href="/api/docs" target="_blank" rel="noreferrer">
            /api/docs
          </a>
        </p>
        <p style={{ marginBottom: 0 }}>
          Las URLs de conexión se guardan cifradas con AES-256-GCM y jamás se devuelven en la API:
          sólo el <code>agent</code> las recibe para alimentar a FFmpeg.
        </p>
      </div>
    </div>
  );
}
