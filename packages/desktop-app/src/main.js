/**
 * FlyCode Note: Desktop app main process
 * Starts/stops local service, opens dashboard window, and keeps lifecycle under one desktop process.
 */
import { app, BrowserWindow, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const localServiceDist = path.resolve(repoRoot, "packages/local-service/dist/index.js");
const rendererDistHtml = path.resolve(repoRoot, "packages/desktop-app/src/renderer/dist/index.html");
const rendererDevUrl = process.env.FLYCODE_RENDERER_URL?.trim();

let mainWindow = null;
let serviceProcess = null;
let quitting = false;
const shouldManageLocalService = process.env.FLYCODE_SKIP_LOCAL_SERVICE !== "1";

await app.whenReady();
if (shouldManageLocalService) {
  startLocalService();
}
createMainWindow();

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on("before-quit", () => {
  quitting = true;
  if (shouldManageLocalService) {
    stopLocalService();
  }
});

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1060,
    minHeight: 700,
    title: "FlyCode Desktop",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  if (rendererDevUrl) {
    mainWindow.loadURL(rendererDevUrl).catch((error) => {
      console.error("[FlyCode Desktop] failed to load renderer dev server", error);
    });
  } else if (fs.existsSync(rendererDistHtml)) {
    mainWindow.loadFile(rendererDistHtml).catch((error) => {
      console.error("[FlyCode Desktop] failed to load renderer build output", error);
    });
  } else {
    mainWindow.loadURL(
      `data:text/html,${encodeURIComponent(
        "<h3>FlyCode Desktop renderer not built.</h3><p>Run: npm run build -w @flycode/desktop-app</p>"
      )}`
    ).catch((error) => {
      console.error("[FlyCode Desktop] failed to load fallback page", error);
    });
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (!quitting) {
      app.quit();
    }
  });
}

function startLocalService() {
  if (serviceProcess) {
    return;
  }

  if (fs.existsSync(localServiceDist)) {
    serviceProcess = spawn(process.execPath, [localServiceDist], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env
      }
    });
  } else {
    serviceProcess = spawn("npm", ["run", "dev", "-w", "@flycode/local-service"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env
      }
    });
  }

  serviceProcess.stdout?.on("data", (chunk) => {
    process.stdout.write(`[local-service] ${String(chunk)}`);
  });

  serviceProcess.stderr?.on("data", (chunk) => {
    process.stderr.write(`[local-service] ${String(chunk)}`);
  });

  serviceProcess.on("exit", (code, signal) => {
    console.log(`[FlyCode Desktop] local-service exited code=${code} signal=${signal}`);
    serviceProcess = null;
  });
}

function stopLocalService() {
  if (!serviceProcess) {
    return;
  }
  serviceProcess.kill("SIGTERM");
}
