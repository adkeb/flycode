/**
 * FlyCode Note: Vite config for desktop renderer
 * Builds React renderer into src/renderer/dist so Electron main process can load static assets.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(process.cwd(), "renderer"),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: path.resolve(process.cwd(), "src/renderer/dist"),
    emptyOutDir: true
  }
});
