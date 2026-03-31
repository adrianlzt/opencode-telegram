import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  outDir: "dist",
  dts: true,
  clean: true,
  bundle: true,
  noExternal: ["telegraf", "dotenv", "jsonc-parser"],
  sourcemap: true,
});
