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
  noExternal: [/^@cameras\//],
  // FFmpeg se invoca por proceso hijo: no se empaqueta.
  banner: {
    js: "// cameras-center agent (build tsup)",
  },
});
