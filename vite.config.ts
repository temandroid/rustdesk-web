import { defineConfig } from "vite";

// One self-contained IIFE so flutter/web/index.html can load it with a plain
// <script> tag before flutter_bootstrap.js. No code splitting, no hashes.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
    lib: {
      entry: "src/index.ts",
      name: "RustDeskWebCore",
      formats: ["iife"],
      fileName: () => "rustdesk-web-core.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
