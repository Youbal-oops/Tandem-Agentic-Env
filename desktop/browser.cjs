// The browser Tandem gives its agents: one window per agent, each with its own empty, in-memory session (no cookies
// or logins from anywhere else). The agent reads the page as text plus numbered elements and acts with real mouse and
// keyboard input. Only http and https pages load; downloads, permission prompts and other protocols are refused.
// The server reaches this through globalThis.tandemDesktop.browser (see main.cjs and server/tools/index.mjs).

const { BrowserWindow } = require('electron');

const LOAD_MS = 20000;
const SETTLE_MS = 3000;
const MAX_LOG = 100;
const isWeb = (url) => { try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs inside the page: numbers the visible interactive elements and returns them with the page text.
const SNAPSHOT = `(() => {
  document.querySelectorAll('[data-tandem-ref]').forEach((e) => e.removeAttribute('data-tandem-ref'));
  const sel = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[onclick],[contenteditable=""],[contenteditable="true"]';
  const visible = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const clean = (v, n) => String(v ?? '').trim().replace(/\\s+/g, ' ').slice(0, n);
  const elements = [];
  for (const e of document.querySelectorAll(sel)) {
    if (elements.length >= 150) break;
    if (e.disabled || !visible(e)) continue;
    const tag = e.tagName.toLowerCase();
    const n = elements.length + 1;
    e.setAttribute('data-tandem-ref', String(n));
    const secret = tag === 'input' && e.type === 'password';
    elements.push({ ref: n, tag, type: e.getAttribute('type') || undefined, text: clean(e.innerText || e.value || e.getAttribute('aria-label') || e.title, 80) || undefined,
      href: tag === 'a' ? clean(e.getAttribute('href'), 120) : undefined, placeholder: e.getAttribute('placeholder') || undefined,
      value: (tag === 'input' || tag === 'textarea' || tag === 'select') && !secret ? clean(e.value, 60) || undefined : undefined });
  }
  return { url: location.href, title: document.title, text: clean(document.body ? document.body.innerText : '', 6000).replace(/ {2,}/g, ' '), elements };
})()`;

const find = (ref) => `document.querySelector('[data-tandem-ref="${Number(ref)}"]')`;

function createBrowserHost() {
  const windows = new Map(); // agent id -> { win, wc, console: [], network: [] }
  const host = { creating: false, windows };

  function ensure(id, title) {
    const have = windows.get(id);
    if (have) return have;
    host.creating = true; // main.cjs leaves windows made now alone: they may go to any web address
    let win;
    try {
      win = new BrowserWindow({ width: 1100, height: 780, show: false, autoHideMenuBar: true, backgroundColor: '#ffffff', title: `Tandem browser · ${title || id}`,
        webPreferences: { partition: `tandem-browser-${id}`, contextIsolation: true, nodeIntegration: false, sandbox: true } });
    } finally { host.creating = false; }
    const wc = win.webContents;
    const entry = { win, wc, console: [], network: [] };
    const push = (list, line) => { list.push(line); if (list.length > MAX_LOG) list.shift(); };
    const ses = wc.session;
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.on('will-download', (event) => event.preventDefault());
    ses.webRequest.onCompleted({ urls: ['http://*/*', 'https://*/*'] }, (d) => { if (d.statusCode >= 400) push(entry.network, `${d.statusCode} ${d.method} ${d.url.slice(0, 200)}`); });
    ses.webRequest.onErrorOccurred({ urls: ['http://*/*', 'https://*/*'] }, (d) => push(entry.network, `failed ${d.method} ${d.url.slice(0, 200)} (${d.error})`));
    wc.on('console-message', (e) => {
      if (/Electron Security Warning/.test(e.message)) return; // Electron's own notice about the page, not the page's
      push(entry.console, `${e.level}: ${String(e.message).slice(0, 300)}`);
    });
    wc.setWindowOpenHandler(({ url }) => { if (isWeb(url)) wc.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    for (const event of ['will-navigate', 'will-redirect']) wc.on(event, (e, url) => { if (!isWeb(url)) e.preventDefault(); });
    win.on('closed', () => { if (windows.get(id) === entry) windows.delete(id); });
    windows.set(id, entry);
    win.showInactive();
    return entry;
  }
  const get = (id) => {
    const e = windows.get(id);
    if (!e || e.win.isDestroyed()) throw new Error('No page is open. Use browser_open first.');
    return e;
  };

  /** Wait for a page that is loading (after a click or Enter) to finish, but not for long. */
  async function settle(wc) {
    const end = Date.now() + SETTLE_MS;
    await sleep(250);
    while (wc.isLoading() && Date.now() < end) await sleep(100);
  }

  // Input goes in through the DevTools protocol, which works whether or not the window has the keyboard focus.
  const cdp = (wc, method, params) => {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
    return wc.debugger.sendCommand(method, params);
  };
  async function click(wc, x, y) {
    await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp(wc, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  async function press(wc, key, code, keyCode, text) {
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, ...(text ? { text } : {}) });
    await cdp(wc, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  }

  Object.assign(host, {
    async open(id, url, title) {
      const e = ensure(id, title);
      e.console.length = 0; e.network.length = 0;
      let timer;
      try {
        await Promise.race([e.wc.loadURL(url), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`took longer than ${LOAD_MS / 1000}s to load`)), LOAD_MS); })]);
      } catch (err) {
        // Redirects and pages that stop early still leave something to look at.
        if (!/ERR_ABORTED/.test(err.message)) throw new Error(`Could not open ${url}: ${err.message}`);
      } finally { clearTimeout(timer); }
      return { url: e.wc.getURL(), title: e.wc.getTitle() };
    },
    async snapshot(id) { return get(id).wc.executeJavaScript(SNAPSHOT, true); },
    async click(id, ref) {
      const { wc } = get(id);
      const at = await wc.executeJavaScript(`(() => { const e = ${find(ref)}; if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`, true);
      if (!at) throw new Error(`There is no element ${ref}. Take a new browser_snapshot: the page may have changed.`);
      await sleep(80);
      await click(wc, at.x, at.y);
      await settle(wc);
      return { clicked: ref, url: wc.getURL(), title: wc.getTitle() };
    },
    async type(id, ref, text, submit) {
      const { wc } = get(id);
      const ok = await wc.executeJavaScript(`(() => { const e = ${find(ref)}; if (!e) return 'missing'; e.scrollIntoView({ block: 'center' }); e.focus();
        if (e.isContentEditable) { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return 'ok'; }
        if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') { e.select(); return 'ok'; }
        return 'not-a-field'; })()`, true);
      if (ok === 'missing') throw new Error(`There is no element ${ref}. Take a new browser_snapshot: the page may have changed.`);
      if (ok !== 'ok') throw new Error(`Element ${ref} is not a text field.`);
      if (text) await cdp(wc, 'Input.insertText', { text }); else await press(wc, 'Backspace', 'Backspace', 8); // the field's text is selected, so this replaces or clears it
      if (submit) {
        await press(wc, 'Enter', 'Enter', 13, '\r');
        await settle(wc);
      }
      return { typed: ref, submitted: !!submit, url: wc.getURL() };
    },
    async screenshot(id) {
      const { wc } = get(id);
      let image = await wc.capturePage();
      if (image.getSize().width > 1280) image = image.resize({ width: 1280 });
      return image.toPNG().toString('base64');
    },
    async console(id) { const e = get(id); return { console: e.console.slice(), networkErrors: e.network.slice() }; },
    /** Bring an agent's window forward for the user. */
    async show(id) { const e = get(id); if (e.win.isMinimized()) e.win.restore(); e.win.show(); e.win.focus(); return { shown: true }; },
    close(id) {
      const e = windows.get(id);
      if (!e) return { closed: false };
      windows.delete(id);
      if (!e.win.isDestroyed()) e.win.destroy();
      return { closed: true };
    },
    closeAll() { for (const id of [...windows.keys()]) host.close(id); },
  });
  return host;
}

module.exports = { createBrowserHost };
