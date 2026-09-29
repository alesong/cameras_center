import type { Camera } from "@cameras/protocol";
import type { ReactNode } from "react";
import { CameraCard } from "./CameraCard";
import type { CameraStatus } from "@cameras/protocol";

export interface CameraGridProps {
  cameras: Camera[];
  statuses?: Record<string, CameraStatus>;
  streamUrls?: Record<string, string>;
  thumbnails?: Record<string, string>;
  viewers?: Record<string, number>;
  onSelect?: (camera: Camera) => void;
  /** Acciones adicionales en el pie de cada tarjeta (p.ej. eliminar). */
  actions?: (camera: Camera) => ReactNode;
  emptyMessage?: string;
}

export function CameraGrid({
  cameras,
  statuses = {},
  streamUrls = {},
  thumbnails = {},
  viewers = {},
  onSelect,
  actions,
  emptyMessage = "Aún no hay cámaras configuradas.",
}: CameraGridProps) {
  if (cameras.length === 0) {
    return (
      <div
        style={{
          border: "1px dashed #2c3140",
          borderRadius: 12,
          padding: "48px 24px",
          textAlign: "center",
          color: "#8b93a5",
        }}
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 16,
      }}
    >
      {cameras.map((camera) => (
        <CameraCard
          key={camera.id}
          camera={camera}
          status={statuses[camera.id] ?? "unknown"}
          streamUrl={streamUrls[camera.id]}
          thumbnailUrl={thumbnails[camera.id]}
          activeViewers={viewers[camera.id]}
          onSelect={onSelect}
        >
          {actions?.(camera)}
        </CameraCard>
      ))}
    </div>
  );
}
