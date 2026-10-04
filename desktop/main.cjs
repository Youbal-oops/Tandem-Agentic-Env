const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

let window;

async function start() {
  const appRoot = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
  const workspace = path.join(app.getPath('documents'), 'Tandem Workspace');
  fs.mkdirSync(workspace, { recursive: true });
  process.env.TANDEM_APP_ROOT = appRoot;
  process.env.TANDEM_DATA_ROOT = app.getPath('userData');
  process.env.TANDEM_JOB_SCRIPT_ROOT = appRoot;
  process.env.TANDEM_CWD ||= workspace;

  await import(path.join(__dirname, '..', 'server', 'index.mjs'));
  window = new BrowserWindow({
    width: 1440, height: 940, minWidth: 980, minHeight: 700,
    backgroundColor: '#07111f',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL('http://127.0.0.1:4317');
}

app.whenReady().then(start).catch((error) => { console.error(error); app.quit(); });
app.on('window-all-closed', () => app.quit());
