/**
 * FlyCode Note: Desktop app main process (CommonJS bootstrap for Windows compatibility).
 */
const { app, BrowserWindow, shell } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const __dirnameLocal = __dirname;
const repoRoot = path.resolve(__dirnameLocal, "../../..");
const rendererDevUrl = (process.env.FLYCODE_RENDERER_URL || "").trim();
const shouldManageLocalService = process.env.FLYCODE_SKIP_LOCAL_SERVICE !== "1";

app.disableHardwareAcceleration();

function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}\n${error.stack || ""}`.trim();
  }
  return String(error);
}

function resolvePackagedAppRoot() {
  try {
    return app.getAppPath();
  } catch {
    return null;
  }
}

function resolveLogFilePath() {
  const fallback = path.resolve(os.tmpdir(), "flycode-desktop-main.log");
  try {
    if (app.isReady()) {
      return path.resolve(app.getPath("userData"), "desktop-main.log");
    }
  } catch {
    // ignore
  }
  return fallback;
}

function safeLog(message, error = null) {
  const timestamp = new Date().toISOString();
  const detail = error ? `\n${formatError(error)}` : "";
  const line = `[${timestamp}] ${message}${detail}\n`;
  try {
    fs.appendFileSync(resolveLogFilePath(), line, "utf-8");
  } catch (writeErr) {
    try {
      fs.appendFileSync(path.resolve(os.tmpdir(), "flycode-desktop-main.log"), line, "utf-8");
    } catch {
      // give up silently
    }
    console.error("[FlyCode Desktop] failed to write log file", writeErr);
  }
  if (error) {
    console.error(`[FlyCode Desktop] ${message}`, error);
  } else {
    console.log(`[FlyCode Desktop] ${message}`);
  }
}

function resolveRendererHtmlPath() {
  const packagedAppRoot = resolvePackagedAppRoot();
  return firstExistingPath([
    path.resolve(repoRoot, "packages/desktop-app/src/renderer/dist/index.html"),
    packagedAppRoot ? path.resolve(packagedAppRoot, "src/renderer/dist/index.html") : "",
    path.resolve(process.resourcesPath || "", "app.asar/src/renderer/dist/index.html")
  ]);
}

function resolveLocalServiceEntryPath() {
  const packagedAppRoot = resolvePackagedAppRoot();
  return firstExistingPath([
    path.resolve(repoRoot, "packages/desktop-app/dist/local-service/index.cjs"),
    packagedAppRoot ? path.resolve(packagedAppRoot, "dist/local-service/index.cjs") : "",
    path.resolve(process.resourcesPath || "", "app.asar.unpacked/dist/local-service/index.cjs"),
    path.resolve(repoRoot, "packages/local-service/dist/index.js")
  ]);
}

let mainWindow = null;
let serviceProcess = null;
let quitting = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1060,
    minHeight: 700,
    show: true,
    title: "FlyCode Desktop",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  if (rendererDevUrl) {
    mainWindow.loadURL(rendererDevUrl).catch((error) => safeLog("failed to load renderer dev server", error));
  } else {
    const rendererHtml = resolveRendererHtmlPath();
    if (rendererHtml) {
      mainWindow.loadFile(rendererHtml).catch((error) => safeLog("failed to load renderer build output", error));
    } else {
      mainWindow
        .loadURL(
          `data:text/html,${encodeURIComponent(
            "<h3>FlyCode Desktop renderer not built.</h3><p>Run: npm run build -w @flycode/desktop-app</p>"
          )}`
        )
        .catch((error) => safeLog("failed to load fallback page", error));
    }
  }

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    safeLog(`renderer did-fail-load code=${errorCode} url=${validatedURL} desc=${errorDescription || "unknown"}`);
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    safeLog(`renderer process gone: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  mainWindow.webContents.on("unresponsive", () => {
    safeLog("renderer became unresponsive");
  });

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

  const localServiceEntry = resolveLocalServiceEntryPath();
  const localServiceCwd = app.isPackaged ? path.dirname(process.execPath) : repoRoot;

  if (localServiceEntry) {
    safeLog(`starting local-service from bundled entry: ${localServiceEntry}`);
    serviceProcess = spawn(process.execPath, [localServiceEntry], {
      cwd: localServiceCwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1"
      }
    });
  } else if (!app.isPackaged) {
    safeLog("bundled local-service entry not found; fallback to npm dev server");
    serviceProcess = spawn("npm", ["run", "dev", "-w", "@flycode/local-service"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env }
    });
  } else {
    safeLog("bundled local-service entry not found in packaged app; service will not be started");
    return;
  }

  serviceProcess.stdout &&
    serviceProcess.stdout.on("data", (chunk) => {
      process.stdout.write(`[local-service] ${String(chunk)}`);
    });

  serviceProcess.stderr &&
    serviceProcess.stderr.on("data", (chunk) => {
      process.stderr.write(`[local-service] ${String(chunk)}`);
    });

  serviceProcess.on("error", (error) => {
    safeLog("local-service process spawn failed", error);
  });

  serviceProcess.on("exit", (code, signal) => {
    safeLog(`local-service exited code=${code} signal=${signal}`);
    serviceProcess = null;
  });
}

function stopLocalService() {
  if (!serviceProcess) {
    return;
  }
  serviceProcess.kill("SIGTERM");
}

process.on("uncaughtException", (error) => {
  safeLog("uncaughtException in main process", error);
});

process.on("unhandledRejection", (reason) => {
  safeLog("unhandledRejection in main process", reason);
});

app
  .whenReady()
  .then(() => {
    safeLog(`main process ready; app.isPackaged=${app.isPackaged}`);
    createMainWindow();
    if (shouldManageLocalService) {
      startLocalService();
    }
  })
  .catch((error) => {
    safeLog("app.whenReady failed", error);
  });

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

app.on("window-all-closed", () => {
  if (shouldManageLocalService) {
    stopLocalService();
  }
  app.quit();
});
