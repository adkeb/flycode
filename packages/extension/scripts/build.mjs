import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dist = path.join(root, "dist");
const staticDir = path.join(root, "static");

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });

await build({
  entryPoints: {
    background: path.join(root, "src/background/index.ts"),
    content: path.join(root, "src/content/index.ts"),
    options: path.join(root, "src/options/index.ts"),
    confirm: path.join(root, "src/confirm/index.ts")
  },
  outdir: dist,
  bundle: true,
  format: "esm",
  target: ["chrome120", "edge120"],
  sourcemap: true,
  minify: false,
  logLevel: "info"
});

await copyDir(staticDir, dist);

async function copyDir(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await fs.mkdir(to, { recursive: true });
      await copyDir(from, to);
      continue;
    }
    await fs.copyFile(from, to);
  }
}
