const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let window;
const smokeTest = process.argv.includes('--tandem-smoke-test');
if (process.env.TANDEM_DATA_ROOT) {
  fs.mkdirSync(process.env.TANDEM_DATA_ROOT, { recursive: true });
  app.setPath('userData', process.env.TANDEM_DATA_ROOT);
}

async function start() {
  const appRoot = app.isPackaged ? path.join(process.resourcesPath, 'app') : path.join(__dirname, '..');
  const workspace = path.join(app.getPath('documents'), 'Tandem Workspace');
  fs.mkdirSync(workspace, { recursive: true });
  process.env.TANDEM_APP_ROOT = appRoot;
  process.env.TANDEM_DATA_ROOT ||= app.getPath('userData');
  process.env.TANDEM_JOB_SCRIPT_ROOT = appRoot;
  process.env.TANDEM_CWD ||= workspace;

  // Dynamic ESM imports need a file URL on Windows; a raw C:\\ path is treated
  // as an unsupported URL scheme by Electron's loader.
  await import(pathToFileURL(path.join(__dirname, '..', 'server', 'index.mjs')).href);
  window = new BrowserWindow({
    show: !smokeTest,
    width: 1440, height: 940, minWidth: 980, minHeight: 700,
    backgroundColor: '#07111f',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  const appUrl = `http://127.0.0.1:${Number(process.env.TANDEM_PORT || 4317)}`;
  const isAppUrl = (url) => { try { return new URL(url).origin === appUrl; } catch { return false; } };
  // Only Tandem's own pop-out pages may open a window: the review window and a subagent's chat.
  const POPUPS = new Set(['/review.html', '/child.html']);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url) && POPUPS.has(new URL(url).pathname)) {
      return { action: 'allow', overrideBrowserWindowOptions: { backgroundColor: '#02030a', autoHideMenuBar: true, minWidth: 420, minHeight: 360, webPreferences: { contextIsolation: true, nodeIntegration: false } } };
    }
    if (!isAppUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // The pop-outs get the same rules, and may not open further windows of their own.
  app.on('web-contents-created', (_event, contents) => {
    if (contents === window.webContents) return;
    contents.setWindowOpenHandler(({ url }) => { if (!isAppUrl(url)) shell.openExternal(url); return { action: 'deny' }; });
    contents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) { event.preventDefault(); shell.openExternal(url); } });
  });
  window.on('closed', () => app.quit());
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) { event.preventDefault(); shell.openExternal(url); }
  });
  // The embedded server begins listening asynchronously after import. A packaged
  // app can reach this point before the socket is ready, so retry instead of
  // quitting on an initial ECONNREFUSED.
  let loaded = false;
  for (let attempt = 0; attempt < 30 && !loaded; attempt++) {
    try { await window.loadURL(appUrl); loaded = true; }
    catch { await new Promise((resolve) => setTimeout(resolve, 200)); }
  }
  if (!loaded) throw new Error('Tandem’s local server did not start.');
}

app.whenReady().then(start).catch((error) => {
  console.error(error);
  const detail = String(error?.stack || error).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const failed = new BrowserWindow({ show: !smokeTest, width: 620, height: 360, backgroundColor: '#07111f', webPreferences: { contextIsolation: true, nodeIntegration: false } });
  failed.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<body style="margin:32px;background:#07111f;color:#f4f1e8;font:16px system-ui"><h1>Tandem could not start</h1><p>Close Tandem, then try again. If this keeps happening, copy this error:</p><pre style="white-space:pre-wrap;color:#ffb25a">${detail}</pre></body>`)}`);
});
app.on('window-all-closed', () => app.quit());
