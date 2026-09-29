import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fromPackage = (name: string) => path.resolve(here, `../../packages/${name}/src/index.ts`);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@cameras/protocol": fromPackage("protocol"),
      "@cameras/core": fromPackage("core"),
      "@cameras/ui": fromPackage("ui"),
    },
  },
  // Los paquetes del monorepo son TS en source: no pre-empaquetarlos.
  optimizeDeps: { exclude: ["@cameras/protocol", "@cameras/core", "@cameras/ui"] },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
      "/socket.io": { target: "http://localhost:4000", ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
