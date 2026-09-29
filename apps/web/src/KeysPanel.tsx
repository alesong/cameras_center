import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, ApiError, type ApiKeyInfo } from "./api";

/**
 * F5: gestión de API keys desde la app.
 *
 * La clave en claro se muestra UNA sola vez al crearla (el server sólo guarda
 * su hash): si se pierde hay que revocarla y crear otra.
 */
export function KeysPanel({ onAuthLost }: { onAuthLost: () => void }) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [label, setLabel] = useState("");
  const [rateLimit, setRateLimit] = useState(60);
  const [scopes, setScopes] = useState<string[]>(["read", "stream"]);
  const [busy, setBusy] = useState(false);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      setKeys(await api.keys.list());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [onAuthLost]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFreshKey(null);
    try {
      const created = await api.keys.create({ label, scopes, rate_limit: rateLimit });
      setFreshKey(created.key);
      setLabel("");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(key: ApiKeyInfo) {
    if (!confirm(`¿Revocar la API key "${key.label}"? Dejará de funcionar al instante.`)) return;
    try {
      await api.keys.revoke(key.id);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onAuthLost();
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyFresh() {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("No se pudo copiar: selecciona la clave y cópiala a mano.");
    }
  }

  return (
    <details className="card-panel keys-panel" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        🔑 API keys para terceros <span className="muted">({keys.length})</span>
      </summary>

      <p className="hint" style={{ marginTop: 12 }}>
        Una API key deja que otra app consuma <strong>la API y los streams</strong> sin compartir tu JWT. Sólo puede
        leer: no crea ni borra cámaras. Documentación completa en{" "}
        <a href="/api/docs" target="_blank" rel="noreferrer">
          /api/docs
        </a>
        .
      </p>

      {error && <div className="error-banner">{error}</div>}

      {freshKey && (
        <div className="fresh-key">
          <strong>🔑 Clave creada (se muestra una sola vez):</strong>
          <div className="fresh-key-row">
            <code>{freshKey}</code>
            <button type="button" className="ghost" onClick={() => void copyFresh()}>
              {copied ? "✓ Copiada" : "Copiar"}
            </button>
            <button type="button" className="ghost" onClick={() => setFreshKey(null)}>
              Entendido
            </button>
          </div>
          <span className="muted">Guárdala en tu app: el servidor sólo conserva su hash SHA-256.</span>
        </div>
      )}

      <form className="form-grid" onSubmit={handleCreate}>
        <label>
          Etiqueta
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="mi-app / domótica / …"
            required
            maxLength={80}
          />
        </label>
        <label>
          Límite (peticiones/min)
          <input
            type="number"
            min={1}
            max={6000}
            value={rateLimit}
            onChange={(e) => setRateLimit(Number(e.target.value) || 60)}
          />
        </label>
        <fieldset className="scopes">
          <legend>Scopes</legend>
          <label>
            <input
              type="checkbox"
              checked={scopes.includes("read")}
              onChange={(e) => setScopes((prev) => (e.target.checked ? [...new Set([...prev, "read"])] : prev.filter((s) => s !== "read")))}
            />{" "}
            read (REST: cámaras, frame.jpg, thumbnails, MJPEG)
          </label>
          <label>
            <input
              type="checkbox"
              checked={scopes.includes("stream")}
              onChange={(e) =>
                setScopes((prev) => (e.target.checked ? [...new Set([...prev, "stream"])] : prev.filter((s) => s !== "stream")))
              }
            />{" "}
            stream (vídeo en vivo por WebSocket)
          </label>
        </fieldset>
        <button type="submit" disabled={busy || scopes.length === 0 || !label.trim()}>
          {busy ? "Creando…" : "Crear API key"}
        </button>
      </form>

      {keys.length === 0 ? (
        <p className="hint">Todavía no hay API keys.</p>
      ) : (
        <table className="keys-table">
          <thead>
            <tr>
              <th>Etiqueta</th>
              <th>Scopes</th>
              <th>Límite</th>
              <th>Creada</th>
              <th>Último uso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id} className={key.revoked ? "revoked" : ""}>
                <td>
                  {key.label} <span className="muted">#{key.id.slice(0, 8)}</span>
                </td>
                <td>{key.scopes.join(" · ")}</td>
                <td>{key.rateLimit}/min</td>
                <td>{new Date(key.createdAt).toLocaleDateString()}</td>
                <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleTimeString() : "—"}</td>
                <td>
                  {key.revoked ? (
                    <span className="muted">revocada</span>
                  ) : (
                    <button type="button" className="ghost" onClick={() => void handleRevoke(key)}>
                      Revocar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </details>
  );
}
