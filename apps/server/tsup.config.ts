import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  splitting: false,
  // Los paquetes del monorepo apuntan a .ts: hay que empaquetarlos.
  // El resto (express, socket.io...) queda external e instalado en runtime.
  noExternal: [/^@cameras\//],
});
