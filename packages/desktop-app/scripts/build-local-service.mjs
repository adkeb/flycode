/**
 * FlyCode Note: Build a standalone local-service runtime bundle for desktop packaging.
 * This avoids requiring a full npm/node_modules tree at end-user runtime.
 */
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(desktopRoot, "../..");
const entryFile = path.resolve(repoRoot, "packages/local-service/src/index.ts");
const outFile = path.resolve(desktopRoot, "dist/local-service/index.cjs");

await fs.mkdir(path.dirname(outFile), { recursive: true });

await build({
  entryPoints: [entryFile],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: false,
  logLevel: "info"
});

console.log(`[desktop-app] local-service bundle generated: ${path.relative(repoRoot, outFile)}`);
