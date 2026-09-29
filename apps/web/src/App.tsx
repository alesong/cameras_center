import { useCallback, useEffect, useState, type FormEvent } from "react";
import { CreateCameraSchema, type Camera, type CreateCameraInput } from "@cameras/protocol";
import { CameraGrid } from "@cameras/ui";
import { api, type HealthResponse } from "./api";

export function App() {
  const [cameras, setCameras] = useState<Camera[]>([]);
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

  const streamUrls: Record<string, string> = live
    ? Object.fromEntries(cameras.map((c) => [c.id, `${agentUrl}/stream/${c.id}.mjpg`]))
    : {};

  const refresh = useCallback(async () => {
    try {
      const [healthData, cameraList] = await Promise.all([api.health(), api.listCameras()]);
      setHealth(healthData);
      setCameras(cameraList);
      setOffline(false);
      setError(null);
    } catch (err) {
      setOffline(true);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 15000);
    return () => clearInterval(id);
  }, [refresh]);

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
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Cameras Center
        </div>
        <div className={`server-pill ${offline ? "error" : health ? "ok" : ""}`}>
          {offline
            ? "server desconectado"
            : health
              ? `server v${health.version} · ${health.env} · uptime ${health.uptimeSec}s`
              : "conectando…"}
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
        actions={(camera) => (
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <a
              className="button-link"
              href={`${agentUrl}/snapshot/${camera.id}.jpg`}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              Capturar
            </a>
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

      <h2 className="section-title">Estado del proyecto</h2>
      <div className="card-panel hint">
        <p style={{ marginTop: 0 }}>
          <strong>F1:</strong> el <code>agent</code> transcodifica cada cámara con FFmpeg y la sirve
          en <code>{agentUrl}</code> como MJPEG. Sólo transcodifica mientras alguien la mira
          (se apaga a los 60 s sin espectadores).
        </p>
        <p style={{ marginBottom: 0 }}>
          Para probar sin hardware real, agrega una cámara con tipo <strong>Test</strong> y
          conexión <code>test://testsrc</code>.
        </p>
      </div>
    </div>
  );
}
