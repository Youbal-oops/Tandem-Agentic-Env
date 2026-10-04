const { app, BrowserWindow, shell } = require('electron');
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
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://127.0.0.1:4317')) shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:4317')) { event.preventDefault(); shell.openExternal(url); }
  });
  // The embedded server begins listening asynchronously after import. A packaged
  // app can reach this point before the socket is ready, so retry instead of
  // quitting on an initial ECONNREFUSED.
  let loaded = false;
  for (let attempt = 0; attempt < 30 && !loaded; attempt++) {
    try { await window.loadURL('http://127.0.0.1:4317'); loaded = true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  if (!loaded) throw new Error('Tandem’s local server did not start.');
}

app.whenReady().then(start).catch((error) => {
  console.error(error);
  const detail = String(error?.stack || error).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const failed = new BrowserWindow({ width: 620, height: 360, backgroundColor: '#07111f', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  failed.loadURL(`data:text/html,<body style="margin:32px;background:%2307111f;color:%23f4f1e8;font:16px system-ui"><h1>Tandem could not start</h1><p>Close Tandem, then try again. If this keeps happening, copy this error:</p><pre style="white-space:pre-wrap;color:%23ffb25a">${detail}</pre></body>`);
});
app.on('window-all-closed', () => app.quit());
