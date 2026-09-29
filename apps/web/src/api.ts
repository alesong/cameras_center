import { API, type Camera, type CreateCameraInput, type CreateCameraPayload } from "@cameras/protocol";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const message =
      typeof body?.error === "string"
        ? body.error
        : `Error ${response.status} en ${init?.method ?? "GET"} ${path}`;
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export interface HealthResponse {
  status: string;
  version: string;
  env: string;
  time: string;
  uptimeSec: number;
}

export const api = {
  health: () => request<HealthResponse>(API.health),

  listCameras: async (): Promise<Camera[]> => {
    const data = await request<{ cameras: Camera[] }>(API.cameras);
    return data.cameras;
  },

  createCamera: async (payload: CreateCameraPayload): Promise<Camera> => {
    const data = await request<{ camera: Camera }>(API.cameras, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return data.camera;
  },

  deleteCamera: async (id: string): Promise<void> => {
    await request<void>(API.camera(id), { method: "DELETE" });
  },
};
