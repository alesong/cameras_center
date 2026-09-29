import type { CameraStatus } from "@cameras/protocol";

const LABELS: Record<CameraStatus, string> = {
  unknown: "Sin datos",
  starting: "Iniciando",
  online: "En línea",
  offline: "Sin señal",
  error: "Error",
};

const COLORS: Record<CameraStatus, { bg: string; fg: string }> = {
  unknown: { bg: "#3a3f4b", fg: "#c7ccd6" },
  starting: { bg: "#4a3d13", fg: "#ffd76a" },
  online: { bg: "#12351f", fg: "#5dde8a" },
  offline: { bg: "#3a2020", fg: "#ff8a8a" },
  error: { bg: "#4a1f2b", fg: "#ff7aa8" },
};

export interface StatusBadgeProps {
  status: CameraStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const color = COLORS[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        background: color.bg,
        color: color.fg,
        borderRadius: 999,
        padding: "2px 10px",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: "18px",
        whiteSpace: "nowrap",
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color.fg,
          boxShadow: status === "online" ? `0 0 6px ${color.fg}` : "none",
        }}
      />
      {LABELS[status]}
    </span>
  );
}
