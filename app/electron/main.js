const { app, BrowserWindow, Menu, ipcMain } = require("electron");
const { fork } = require("child_process");
const path = require("path");

const isDev = !app.isPackaged;
let mainWindow = null;
let connectorProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "Notus",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (isDev) {
    mainWindow.loadURL("http://localhost:5847");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    // Check for updates in production
    checkForUpdates();
  }

  mainWindow.on("page-title-updated", (event) => {
    event.preventDefault();
  });
}

// Auto-update
function checkForUpdates() {
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", () => {
      mainWindow?.webContents.send("update-status", "downloading");
    });

    autoUpdater.on("update-downloaded", () => {
      mainWindow?.webContents.send("update-status", "ready");
    });

    autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    // electron-updater not available in dev
  }
}

ipcMain.on("install-update", () => {
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.quitAndInstall();
  } catch (e) {}
});

// ── Embedded Connector ──────────────────────────
function startConnector() {
  const connectorPath = isDev
    ? path.join(__dirname, "..", "..", "connector", "server.js")
    : path.join(process.resourcesPath, "connector", "server.js");

  try {
    connectorProcess = fork(connectorPath, [], {
      stdio: "pipe",
      env: { ...process.env },
      silent: true,
    });

    connectorProcess.on("error", (err) => {
      console.error("Connector failed to start:", err.message);
    });

    connectorProcess.on("exit", (code) => {
      console.log("Connector exited with code:", code);
      connectorProcess = null;
    });

    console.log("Connector started (PID:", connectorProcess.pid, ")");
  } catch (e) {
    console.error("Could not start connector:", e.message);
  }
}

function stopConnector() {
  if (connectorProcess) {
    connectorProcess.kill();
    connectorProcess = null;
  }
}

// macOS app menu
if (process.platform === "darwin") {
  const template = [
    {
      label: "Notus",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" },
      ],
    },
  ];

  app.whenReady().then(() => {
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
  });
}

app.whenReady().then(() => {
  startConnector();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    stopConnector();
    app.quit();
  }
});

app.on("before-quit", stopConnector);

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
