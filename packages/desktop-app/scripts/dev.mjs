/**
 * FlyCode Note: Desktop dev orchestrator
 * Runs Vite HMR server and Electron together, waiting for renderer readiness before launching Electron.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appRoot = path.resolve(__dirname, "..");
const rendererUrl = process.env.FLYCODE_RENDERER_URL?.trim() || "http://127.0.0.1:5173";
const allowWebFallback = process.env.FLYCODE_DEV_WEB_FALLBACK !== "0";

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
let rendererProcess = null;
let localServiceProcess = null;
let electronProcess = null;
let shuttingDown = false;

main().catch((error) => {
  console.error("[desktop-dev] failed to start", error);
  process.exit(1);
});

async function main() {
  rendererProcess = spawn(npmCmd, ["run", "dev:renderer"], {
    cwd: appRoot,
    stdio: "inherit",
    env: {
      ...process.env
    }
  });

  rendererProcess.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(`[desktop-dev] vite exited unexpectedly code=${code} signal=${signal}`);
    shutdown(code ?? 1);
  });

  localServiceProcess = spawn(npmCmd, ["run", "dev", "-w", "@flycode/local-service"], {
    cwd: path.resolve(appRoot, "../.."),
    stdio: "inherit",
    env: {
      ...process.env
    }
  });

  localServiceProcess.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    console.error(`[desktop-dev] local-service exited unexpectedly code=${code} signal=${signal}`);
    shutdown(code ?? 1);
  });

  await waitForRenderer(rendererUrl, 90_000);

  electronProcess = spawn(npmCmd, ["run", "start"], {
    cwd: appRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      FLYCODE_RENDERER_URL: rendererUrl,
      FLYCODE_SKIP_LOCAL_SERVICE: "1"
    }
  });

  electronProcess.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    if ((code ?? 0) === 0) {
      console.log(`[desktop-dev] electron exited code=${code} signal=${signal}`);
      shutdown(0);
      return;
    }

    if (allowWebFallback) {
      console.error(
        [
          `[desktop-dev] electron exited code=${code} signal=${signal}.`,
          `[desktop-dev] keeping Vite + local-service alive for web fallback: ${rendererUrl}`,
          "[desktop-dev] if error is 'Electron failed to install correctly', run:",
          "  npm rebuild electron -w @flycode/desktop-app"
        ].join("\n")
      );
      electronProcess = null;
      return;
    }

    shutdown(code ?? 1);
  });

  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
}

async function waitForRenderer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (rendererProcess?.exitCode !== null) {
      throw new Error("Renderer process exited before becoming ready");
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      const response = await fetch(url, {
        signal: controller.signal
      });
      clearTimeout(timer);
      if (response.ok || response.status === 404) {
        return;
      }
    } catch {
      // keep waiting
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for renderer dev server: ${url}`);
}

function shutdown(code) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  if (electronProcess && electronProcess.exitCode === null) {
    electronProcess.kill("SIGTERM");
  }
  if (localServiceProcess && localServiceProcess.exitCode === null) {
    localServiceProcess.kill("SIGTERM");
  }
  if (rendererProcess && rendererProcess.exitCode === null) {
    rendererProcess.kill("SIGTERM");
  }

  setTimeout(() => {
    process.exit(code);
  }, 100);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
