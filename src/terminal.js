// Bottom terminal drawer: a command line over the local server (see server/terminal.mjs).
// One line at a time; while a command runs, typed lines go to its stdin. Not a full PTY.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const MAX_CHARS = 300000;
const HEIGHT_KEY = 'tandem:term-height';
const clean = (s) => s.replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

export function createTerminalPanel({ send, connected, getSource, notify }) {
  const $ = (s) => document.querySelector(s);
  const root = $('#term'), out = $('#term-out'), input = $('#term-input'), dirSel = $('#term-dir');
  let shown = false, started = false, running = false, cwd = '', size = 0;
  let history = [], at = 0, dirs = [];

  const base = (p) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
  const nearBottom = () => out.scrollHeight - out.scrollTop - out.clientHeight < 40;

  function write(text, cls = '') {
    if (!text) return;
    const stick = nearBottom();
    text = clean(text);
    if (cls) { const span = document.createElement('span'); span.className = cls; span.textContent = text; out.append(span); }
    else if (out.lastChild?.nodeType === 3) out.lastChild.appendData(text);
    else out.append(document.createTextNode(text));
    size += text.length;
    while (size > MAX_CHARS && out.firstChild !== out.lastChild) { size -= out.firstChild.textContent.length; out.firstChild.remove(); }
    if (stick) out.scrollTop = out.scrollHeight;
  }

  /** Keep the folder picker in step with where the shell actually is, including after a `cd`. */
  function syncDir() {
    const same = (a, b) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
    const here = dirs.find((d) => same(d.cwd, cwd));
    dirSel.replaceChildren(...[...(here ? [] : [{ id: '', name: base(cwd) || cwd, cwd }]), ...dirs].map((d) => Object.assign(document.createElement('option'), { value: d.id, textContent: d.name, title: d.cwd })));
    dirSel.value = here ? here.id : '';
  }

  function status() {
    $('#term-cwd').textContent = cwd; $('#term-cwd').title = cwd;
    $('#term-prompt').textContent = running ? '⏵' : `${base(cwd) || ''} ›`;
    $('#term-stop').disabled = !running;
    input.placeholder = running ? 'Sending to the running command… (Ctrl+C to stop)' : 'Type a command and press Enter';
    root.classList.toggle('running', running);
  }

  function open() {
    if (!connected()) { notify('Turn off Demo and connect to the local server to use the terminal.'); return; }
    shown = true; root.hidden = false; document.body.classList.add('term-open');
    // Only the first open picks a folder; after that the terminal stays wherever the user has cd'd to.
    send({ t: 'term-open', ...(started ? {} : { source: getSource() }) });
    started = true;
    input.focus();
  }
  function close() { shown = false; root.hidden = true; document.body.classList.remove('term-open'); }
  const toggle = () => (shown ? close() : open());

  function submit() {
    const line = input.value;
    input.value = '';
    if (line.trim() && history.at(-1) !== line && !running) history.push(line);
    history = history.slice(-200); at = history.length;
    write(running ? `${line}\n` : `${base(cwd)} › ${line}\n`, 't-echo');
    send({ t: 'term-run', line });
  }
  const stop = () => send({ t: 'term-stop' });

  $('#btn-terminal').addEventListener('click', toggle);
  $('#term-close').addEventListener('click', close);
  $('#term-stop').addEventListener('click', () => { stop(); input.focus(); });
  $('#term-clear').addEventListener('click', () => { out.replaceChildren(); size = 0; input.focus(); });
  dirSel.addEventListener('change', () => { send({ t: 'term-open', source: dirSel.value }); input.focus(); });
  $('#term-form').addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  out.addEventListener('click', () => { if (!getSelection().toString()) input.focus(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp' && !running) { if (at > 0) input.value = history[--at]; e.preventDefault(); }
    else if (e.key === 'ArrowDown' && !running) { at = Math.min(history.length, at + 1); input.value = history[at] ?? ''; e.preventDefault(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c' && input.selectionStart === input.selectionEnd) { e.preventDefault(); if (running) stop(); else input.value = ''; }
    else if (e.ctrlKey && e.key.toLowerCase() === 'l') { e.preventDefault(); $('#term-clear').click(); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === '`' || e.code === 'Backquote')) { e.preventDefault(); toggle(); }
  });

  // Drag the top edge to resize; the height is remembered.
  const setHeight = (h) => document.documentElement.style.setProperty('--term-h', `${Math.round(Math.max(160, Math.min(h, window.innerHeight * 0.7)))}px`);
  try { const saved = Number(localStorage.getItem(HEIGHT_KEY)); if (saved) setHeight(saved); } catch {}
  $('#term-resize').addEventListener('pointerdown', (e) => {
    e.preventDefault(); const bar = e.target; bar.setPointerCapture(e.pointerId);
    const move = (ev) => { setHeight(window.innerHeight - ev.clientY - parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--bot'))); };
    const up = () => { bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); try { localStorage.setItem(HEIGHT_KEY, String(parseInt(getComputedStyle(root).height, 10))); } catch {} };
    bar.addEventListener('pointermove', move); bar.addEventListener('pointerup', up);
  });
  $('#term-resize').addEventListener('dblclick', () => { document.documentElement.style.removeProperty('--term-h'); try { localStorage.removeItem(HEIGHT_KEY); } catch {} });

  return {
    /** The server forgot this terminal (restart, reconnect): open a fresh one if the drawer is showing. */
    reconnected() {
      running = false;
      if (shown) { write('\n[reconnected: the previous shell session was lost]\n', 't-note'); send({ t: 'term-open', source: dirSel.value || getSource() }); status(); }
      else started = false;
    },
    receive(msg) {
      if (msg.t !== 'term') return false;
      if (msg.cwd !== undefined) cwd = msg.cwd;
      if (msg.running !== undefined) running = msg.running;
      if (msg.kind === 'ready') {
        dirs = msg.dirs || [];
        if (!out.childNodes.length) write(`Terminal in ${msg.cwd}\nType a command. Ctrl+C stops it; Ctrl+\` hides this panel. Full-screen programs (vim, htop) are not supported.\n`, 't-note');
      } else if (msg.kind === 'out') write(msg.text);
      else if (msg.kind === 'err') write(msg.text, 't-err');
      else if (msg.kind === 'done' && msg.code) write(`[exit ${msg.code}]\n`, 't-note');
      if (msg.cwd !== undefined) syncDir();
      status();
      return true;
    },
  };
}
