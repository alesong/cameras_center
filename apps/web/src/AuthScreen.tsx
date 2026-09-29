import { useEffect, useState, type FormEvent } from "react";
import { api, setToken, type AuthStatus } from "./api";

export interface AuthScreenProps {
  onAuthenticated: () => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.auth
      .status()
      .then((s) => {
        setStatus(s);
        if (s.needsSetup) setMode("register");
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result =
        mode === "login" ? await api.auth.login(email, password) : await api.auth.register(email, password);
      setToken(result.token);
      onAuthenticated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="brand" style={{ justifyContent: "center" }}>
          <span className="dot" />
          Cameras Center
        </div>

        <h2 style={{ fontSize: 18, textAlign: "center", margin: "8px 0 4px" }}>
          {mode === "login" ? "Iniciar sesión" : "Crear usuario propietario"}
        </h2>
        <p className="hint" style={{ textAlign: "center", marginTop: 0 }}>
          {status
            ? mode === "login"
              ? `Almacenamiento: ${status.backend} · ${status.jwt === "configured" ? "JWT activo" : "JWT sin configurar"}`
              : status.needsSetup
                ? "Primer usuario: quedará como propietario."
                : "Registro de usuarios nuevos"
            : "Comprobando servidor…"}
        </p>

        {error && <div className="error-banner">{error}</div>}

        <form className="auth-form" onSubmit={submit}>
          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="tu@email.com"
              autoComplete="email"
              required
            />
          </label>
          <label>
            Contraseña
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="mínimo 8 caracteres"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              minLength={8}
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Un momento…" : mode === "login" ? "Entrar" : "Crear cuenta"}
          </button>
        </form>

        {status?.allowRegister && (
          <button
            className="ghost"
            type="button"
            style={{ width: "100%", marginTop: 10 }}
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "¿Primera vez? Crear usuario" : "Ya tengo cuenta"}
          </button>
        )}
      </div>
    </div>
  );
}
