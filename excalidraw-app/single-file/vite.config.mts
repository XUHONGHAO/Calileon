import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import svgrPlugin from "vite-plugin-svgr";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../..");

export default defineConfig({
  base: "./",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  publicDir: false,
  resolve: {
    alias: [
      ["@excalidraw/common", "packages/common/src"],
      ["@excalidraw/element", "packages/element/src"],
      ["@excalidraw/excalidraw", "packages/excalidraw"],
      ["@excalidraw/math", "packages/math/src"],
      ["@excalidraw/utils", "packages/utils/src"],
      ["@excalidraw/fractional-indexing", "packages/fractional-indexing/src"],
    ].map(([find, replacement]) => ({
      find: new RegExp(`^${find.replace("/", "\\/")}(?:\\/(.*))?$`),
      replacement: path.resolve(repoRoot, replacement, "$1"),
    })),
  },
  plugins: [react(), svgrPlugin()],
  build: {
    outDir: path.resolve(dirname, ".runtime-build"),
    emptyOutDir: true,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    cssCodeSplit: false,
    sourcemap: false,
    minify: "esbuild",
    lib: {
      entry: path.resolve(dirname, "runtime.tsx"),
      formats: ["iife"],
      name: "CalileonSingleFileRuntime",
      fileName: () => "runtime.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: "[name][extname]",
      },
    },
  },
});
