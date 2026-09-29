import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import type { Camera, CameraStatus } from "@cameras/protocol";
import { StatusBadge } from "./StatusBadge";

export interface CameraCardProps {
  camera: Camera;
  status?: CameraStatus;
  /** URL de la imagen en vivo (MJPEG/HLS poster). Si no hay, muestra placeholder. */
  streamUrl?: string;
  /** Thumbnail de Cloudinary como fallback estático. */
  thumbnailUrl?: string;
  activeViewers?: number;
  children?: ReactNode;
  onSelect?: (camera: Camera) => void;
}

export function CameraCard({
  camera,
  status = "unknown",
  streamUrl,
  thumbnailUrl,
  activeViewers,
  children,
  onSelect,
}: CameraCardProps) {
  const [imageOk, setImageOk] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // cambiar de fuente reinicia el estado del <img>
  useEffect(() => {
    setImageOk(true);
    setLoaded(false);
  }, [streamUrl]);

  const poster = streamUrl && imageOk ? streamUrl : thumbnailUrl;
  const effectiveStatus: CameraStatus =
    streamUrl && !imageOk ? "offline" : loaded || !streamUrl ? status : "starting";

  return (
    <article
      onClick={() => onSelect?.(camera)}
      style={{
        background: "#14161c",
        border: "1px solid #242833",
        borderRadius: 12,
        overflow: "hidden",
        cursor: onSelect ? "pointer" : "default",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          background: "#0b0c10",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {poster ? (
          <img
            src={poster}
            alt={camera.name}
            onLoad={() => setLoaded(true)}
            onError={() => setImageOk(false)}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        ) : (
          <span style={{ color: "#4a5060", fontSize: 13 }}>
            {streamUrl && !loaded ? "Conectando…" : "Sin señal de video"}
          </span>
        )}

        <div style={{ position: "absolute", top: 8, left: 8 }}>
          <StatusBadge status={effectiveStatus} />
        </div>

        {typeof activeViewers === "number" && activeViewers > 0 && (
          <div
            style={{
              position: "absolute",
              top: 8,
              right: 8,
              background: "rgba(0,0,0,.65)",
              color: "#dfe3ea",
              fontSize: 11,
              padding: "2px 8px",
              borderRadius: 999,
            }}
          >
            👁 {activeViewers}
          </div>
        )}
      </div>

      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 2 }}>
        <strong style={{ fontSize: 14, color: "#eef1f6" }}>{camera.name}</strong>
        <span style={{ fontSize: 12, color: "#8b93a5" }}>
          {camera.brand ?? camera.sourceType.toUpperCase()} · {camera.host}
        </span>
        {children}
      </div>
    </article>
  );
}
