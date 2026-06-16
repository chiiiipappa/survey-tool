"use strict";

const { app, BrowserWindow, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn, spawnSync } = require("child_process");

const HOST = "127.0.0.1";
const PORT = 8002;

const RESOURCES_DIR = app.isPackaged
  ? process.resourcesPath
  : path.join(__dirname, "..");

const REQUIREMENTS_FILE = path.join(RESOURCES_DIR, "requirements.txt");
const VENV_DIR = path.join(app.getPath("userData"), "venv");
const IS_WIN = process.platform === "win32";
const VENV_PYTHON = IS_WIN
  ? path.join(VENV_DIR, "Scripts", "python.exe")
  : path.join(VENV_DIR, "bin", "python3");

let mainWindow = null;
let backendProcess = null;

function findSystemPython() {
  const candidates = IS_WIN ? ["python", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    const result = spawnSync(cmd, ["--version"]);
    if (!result.error && result.status === 0) return cmd;
  }
  return null;
}

function runCommand(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} (code ${code})\n${stderr}`));
    });
  });
}

async function ensureBackendEnv(onStatus) {
  if (fs.existsSync(VENV_PYTHON)) return;

  onStatus("Python環境を確認しています...");
  const systemPython = findSystemPython();
  if (!systemPython) {
    throw new Error(
      "Python3 が見つかりません。https://www.python.org からインストールしてください。"
    );
  }

  onStatus("初回セットアップ: 仮想環境を作成しています...");
  await runCommand(systemPython, ["-m", "venv", VENV_DIR]);

  onStatus("初回セットアップ: 依存ライブラリをインストールしています（数分かかります）...");
  await runCommand(VENV_PYTHON, ["-m", "pip", "install", "-q", "-r", REQUIREMENTS_FILE]);
}

function waitForServer(timeoutMs = 60000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: HOST, port: PORT, path: "/health", timeout: 1500 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error("サーバーの起動がタイムアウトしました。"));
        } else {
          setTimeout(tryOnce, 500);
        }
      });
    };
    tryOnce();
  });
}

function startBackend() {
  backendProcess = spawn(
    VENV_PYTHON,
    ["-m", "uvicorn", "app.main:app", "--host", HOST, "--port", String(PORT)],
    { cwd: RESOURCES_DIR, env: process.env }
  );
  backendProcess.stdout.on("data", (d) => process.stdout.write(`[backend] ${d}`));
  backendProcess.stderr.on("data", (d) => process.stderr.write(`[backend] ${d}`));
  backendProcess.on("exit", (code) => {
    console.log(`backend exited with code ${code}`);
  });
}

function updateStatus(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const script = `window.setStatus && window.setStatus(${JSON.stringify(message)})`;
  mainWindow.webContents.executeJavaScript(script).catch(() => {});
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    title: "SurveyTool",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "loading.html"));
}

app.whenReady().then(async () => {
  createWindow();
  try {
    await ensureBackendEnv(updateStatus);
    updateStatus("サーバーを起動しています...");
    startBackend();
    await waitForServer();
    await mainWindow.loadURL(`http://${HOST}:${PORT}/`);
  } catch (err) {
    dialog.showErrorBox("起動エラー", err.message || String(err));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (backendProcess) backendProcess.kill();
});
