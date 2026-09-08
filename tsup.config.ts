import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  dts: true,
  clean: true,
  bundle: true,
  minify: false,
  splitting: false,
  sourcemap: true,
  target: "node18",
  external: [],
});
