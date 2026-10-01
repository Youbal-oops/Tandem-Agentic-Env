import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});
const md = (src) => DOMPurify.sanitize(marked.parse(src || ''));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`);

const TOOL_LABEL = { Bash: 'Shell', PowerShell: 'Shell', Shell: 'Shell', Read: 'Read', Write: 'Write', Edit: 'Edit', MultiEdit: 'Edit', Glob: 'Find', Grep: 'Search', WebFetch: 'Fetch', WebSearch: 'Web', Task: 'Agent', Agent: 'Agent' };
export const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class ChatPanel {
  constructor(root, { id, name, otherName, modes, handlers }) {
    this.root = root;
    this.id = id;
    this.name = name;
    this.otherName = otherName;
    this.h = handlers;
    this.modes = modes;
    this.entries = new Map();
    this.running = new Set();
    this.meta = { busy: false, mode: modes[0].id, available: true, awaiting: 0 };
    this.offline = false;
    this.pending = new Set();

    root.classList.add('agent');
    root.dataset.agent = id;
    root.innerHTML = `
      <header class="a-row" role="button" tabindex="0" title="Focus this agent">
        <span class="num">${id === 'claude' ? '01' : '02'}</span>
        <span class="name">${esc(name)}</span>
        <span class="tag"></span>
        <canvas class="spark" width="240" height="56"></canvas>
        <span class="stat"><b>idle</b><i>not started</i></span>
      </header>
      <div class="a-body">
        <div class="a-bar">
          <div class="modes" role="group" aria-label="Permission mode">${modes
            .map((m) => `<button data-mode="${m.id}" title="${esc(m.hint)}">${esc(m.label)}</button>`)
            .join('')}</div>
          <span class="a-info"></span>
          <button class="c-new" title="Start a fresh conversation">new chat</button>
        </div>
        <div class="c-feed" tabindex="-1">
          <div class="c-empty">
            <p class="big">Ask ${esc(name)}</p>
            <p class="small">about this codebase, or hand it a task.</p>
            <div class="chips">
              <button>Give me a tour of this repo</button>
              <button>What looks risky or unfinished?</button>
              <button>Suggest the next small improvement</button>
            </div>
          </div>
          <div class="c-working" hidden><i></i><i></i><i></i><span>working</span></div>
        </div>
        <div class="c-compose">
          <span class="pr">›</span>
          <textarea rows="1" placeholder="Message ${esc(name)}…" spellcheck="true"></textarea>
          <button class="send" title="Send (Enter)" aria-label="Send">send ⏎</button>
          <button class="stop" title="Stop" aria-label="Stop">■ stop</button>
        </div>
      </div>`;

    this.$ = (s) => root.querySelector(s);
    this.feed = this.$('.c-feed');
    this.ta = this.$('textarea');
    this.working = this.$('.c-working');
    this.empty = this.$('.c-empty');
    this.spark = this.$('.spark').getContext('2d');

    const row = this.$('.a-row');
    row.addEventListener('click', () => this.h.focus());
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        this.h.focus();
      }
    });
    this.$('.send').addEventListener('click', () => this.submit());
    this.$('.stop').addEventListener('click', () => this.h.stop());
    this.$('.c-new').addEventListener('click', () => {
      if (this.entries.size === 0 || confirm(`Start a new conversation with ${name}? The current one stays in the CLI's history but leaves this view.`)) this.h.newChat();
    });
    root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => this.h.mode(b.dataset.mode)));
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      }
    });
    this.ta.addEventListener('input', () => this.autosize());
    this.empty.querySelectorAll('.chips button').forEach((b) => b.addEventListener('click', () => ((this.ta.value = b.textContent), this.submit())));
    this.feed.addEventListener('click', (e) => this.onFeedClick(e));
    this.refresh();
  }

  // ------------------------------------------------------------ input
  autosize() {
    this.ta.style.height = 'auto';
    this.ta.style.height = Math.min(this.ta.scrollHeight, 190) + 'px';
  }
  submit() {
    const text = this.ta.value.trim();
    if (!text || this.meta.busy || this.offline || !this.meta.available) return;
    this.h.send(text);
    this.ta.value = '';
    this.autosize();
  }
  setDraft(text) {
    this.ta.value = text;
    this.autosize();
    this.ta.focus();
  }
  focusInput() {
    this.ta.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ state
  setMeta(meta) {
    this.meta = { ...this.meta, ...meta };
    this.refresh();
  }
  setOffline(v) {
    this.offline = v;
    this.refresh();
  }
  get state() {
    const m = this.meta;
    if (this.offline) return ['offline', 'offline'];
    if (!m.available) return ['missing', 'not installed'];
    if (m.awaiting > 0) return ['wait', 'needs your approval'];
    if (m.busy) return this.running.size ? ['work', `working · ${this.running.size} step${this.running.size > 1 ? 's' : ''}`] : ['think', 'thinking'];
    return [m.running || m.session ? 'ready' : 'idle', m.running || m.session ? 'ready' : 'idle'];
  }
  refresh() {
    const m = this.meta;
    const [cls, label] = this.state;
    this.root.dataset.state = cls;
    this.$('.stat b').textContent = cls === 'work' ? 'working' : cls === 'think' ? 'thinking' : cls === 'wait' ? 'needs ok' : cls === 'offline' ? 'offline' : cls === 'missing' ? 'missing' : m.busy ? 'working' : 'idle';
    const ctx = m.stats?.ctx;
    const pct = ctx && ctx.window ? Math.round((ctx.used / ctx.window) * 100) : null;
    this.$('.stat i').textContent = cls === 'work' || cls === 'think' ? label.replace(/^working · /, '') : cls === 'wait' ? 'your approval' : cls === 'ready' && pct !== null ? `ctx ${pct}%` : label;
    this.$('.tag').textContent = (m.mode && this.modes.find((x) => x.id === m.mode)?.label) || '';
    const bits = [];
    if (m.model) bits.push(m.model.replace(/^claude-/, '').replace(/-\d{8}$/, ''));
    if (m.cost) bits.push('$' + m.cost.toFixed(m.cost < 1 ? 3 : 2));
    if (m.turns) bits.push(`${m.turns} turn${m.turns > 1 ? 's' : ''}`);
    this.$('.a-info').textContent = bits.join(' · ');
    this.root.querySelectorAll('[data-mode]').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === m.mode);
      b.disabled = !!m.busy;
    });
    this.root.classList.toggle('busy', !!m.busy);
    this.working.hidden = !m.busy || m.awaiting > 0;
    this.working.querySelector('span').textContent = this.running.size ? `running ${this.running.size} step${this.running.size > 1 ? 's' : ''}` : 'thinking';
    this.ta.disabled = this.offline || !m.available;
    this.ta.placeholder = this.offline ? 'Server offline. Run npm run dev' : !m.available ? 'CLI not found on this machine' : m.busy ? 'Working… you can type the next message' : `Message ${this.name}…`;
    this.feed.appendChild(this.working);
  }

  // ------------------------------------------------------------ events
  reset(events = []) {
    this.entries.clear();
    this.running.clear();
    this.feed.querySelectorAll('.m, .turn, .note, .err').forEach((n) => n.remove());
    this.empty.hidden = false;
    for (const ev of events) this.apply(ev, true);
    this.refresh();
    this.scroll(true);
  }

  apply(ev, replay = false) {
    const stick = this.nearBottom();
    switch (ev.k) {
      case 'user':
        this.addUser(ev);
        break;
      case 'msg':
        this.upsertMsg(ev);
        break;
      case 'delta':
        this.delta(ev);
        break;
      case 'think':
        this.upsertThink(ev);
        break;
      case 'tool':
        this.upsertTool(ev);
        break;
      case 'plan':
        this.upsertPlan(ev);
        break;
      case 'turn':
        this.addTurn(ev);
        break;
      case 'error':
        this.addLine('err', ev);
        break;
      case 'note':
        this.addLine('note', ev);
        break;
    }
    if (ev.k !== 'delta') this.empty.hidden = this.entries.size > 0;
    if (!replay) {
      this.refresh();
      if (stick || ev.k === 'user') this.scroll();
    }
  }

  nearBottom() {
    return this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 90;
  }
  scroll(force) {
    requestAnimationFrame(() => (this.feed.scrollTop = this.feed.scrollHeight));
  }
  add(el) {
    this.feed.insertBefore(el, this.working);
    return el;
  }

  addUser(ev) {
    const el = document.createElement('div');
    el.className = 'm user';
    el.innerHTML = `<span class="pr">›</span><div class="bub"></div>`;
    el.querySelector('.bub').textContent = ev.text;
    this.entries.set(ev.id, { el });
    this.add(el);
  }

  upsertMsg(ev) {
    let en = this.entries.get(ev.id);
    if (!en) {
      const el = document.createElement('div');
      el.className = 'm bot';
      el.innerHTML = `<span class="pr">●</span><div class="body"></div><div class="acts"><button data-act="copy">copy</button><button data-act="fwd">→ ${esc(this.otherName)}</button></div>`;
      en = { el, text: '', body: el.querySelector('.body') };
      this.entries.set(ev.id, en);
      this.add(el);
    }
    if (typeof ev.text === 'string') en.text = ev.text;
    if (ev.done !== undefined) en.el.classList.toggle('streaming', !ev.done);
    else en.el.classList.add('streaming');
    this.render(en);
    en.el.hidden = !en.text && ev.done;
  }

  delta(ev) {
    const en = this.entries.get(ev.id);
    if (!en) return;
    en.text = (en.text || '') + ev.text;
    if (en.think) en.thinkBody.textContent = en.text;
    else this.render(en);
  }

  render(en) {
    if (!en.body || en.queued) return;
    en.queued = true;
    requestAnimationFrame(() => {
      en.queued = false;
      const stick = this.nearBottom();
      en.body.innerHTML = md(en.text);
      en.body.querySelectorAll('pre').forEach((pre) => {
        if (pre.querySelector('.copy')) return;
        const b = document.createElement('button');
        b.className = 'copy';
        b.textContent = 'Copy';
        b.dataset.act = 'copycode';
        pre.appendChild(b);
      });
      if (stick) this.scroll();
    });
  }

  upsertThink(ev) {
    let en = this.entries.get(ev.id);
    if (!en) {
      const el = document.createElement('details');
      el.className = 'm think';
      el.innerHTML = `<summary><span class="pr">✻</span><em>thinking</em><span class="dots"><i></i><i></i><i></i></span></summary><div class="tb"></div>`;
      en = { el, think: true, text: '', thinkBody: el.querySelector('.tb') };
      this.entries.set(ev.id, en);
      this.add(el);
    }
    if (typeof ev.text === 'string') {
      en.text = ev.text;
      en.thinkBody.textContent = en.text;
    }
    if (ev.done !== undefined) en.el.classList.toggle('live', !ev.done);
    else en.el.classList.add('live');
    en.el.hidden = ev.done && !en.text.trim();
  }

  upsertTool(ev) {
    let en = this.entries.get(ev.id);
    if (!en) {
      const el = document.createElement('details');
      el.className = 'm tool';
      el.innerHTML = `<summary><span class="ti"></span><b class="tn"></b><span class="ts"></span><span class="tm"></span></summary>
        <div class="td"></div>
        <div class="appr"><span>? Allow this action</span><button class="ok" data-act="allow">y · approve</button><button class="no" data-act="deny">n · deny</button></div>`;
      en = { el, data: { id: ev.id } };
      this.entries.set(ev.id, en);
      this.add(el);
    }
    Object.assign(en.data, Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== undefined)));
    const d = en.data;
    const status = d.status || 'running';
    en.el.dataset.status = status;
    if (d.cls) en.el.dataset.cls = d.cls;
    en.el.querySelector('.tn').textContent = TOOL_LABEL[d.name] || d.name || 'Tool';
    en.el.querySelector('.ts').textContent = d.summary || '';
    en.el.querySelector('.ts').title = d.summary || '';
    en.el.querySelector('.tm').textContent = status === 'awaiting' ? 'waiting' : status === 'denied' ? 'denied' : fmtMs(d.ms);
    en.el.querySelector('.td').innerHTML = this.detail(d);
    if (status === 'awaiting') en.el.open = true;
    else if (en.el.dataset.wasAwaiting) en.el.open = false;
    en.el.dataset.wasAwaiting = status === 'awaiting' ? '1' : '';
    if (status === 'running' || status === 'awaiting') this.running.add(ev.id);
    else this.running.delete(ev.id);
  }

  detail(d) {
    const inp = d.detail || {};
    let html = '';
    if (d.name === 'Edit' && inp.old_string !== undefined) {
      html += `<pre class="diff del">${esc(inp.old_string)}</pre><pre class="diff add">${esc(inp.new_string)}</pre>`;
    } else if (d.name === 'Write' && inp.content !== undefined) {
      html += `<pre class="diff add">${esc(inp.content)}</pre>`;
    } else if (d.name === 'Shell' || d.name === 'Bash' || d.name === 'PowerShell') {
      html += `<pre class="cmd">${esc(inp.command || d.summary || '')}</pre>`;
    } else if (inp && Object.keys(inp).length && d.name !== 'Read') {
      html += `<pre class="cmd">${esc(JSON.stringify(inp, null, 2))}</pre>`;
    }
    if (d.output) html += `<pre class="out">${esc(d.output)}</pre>`;
    return html || '<p class="none">No details.</p>';
  }

  upsertPlan(ev) {
    let en = this.entries.get(ev.id);
    if (!en) {
      const el = document.createElement('div');
      el.className = 'm plan';
      en = { el };
      this.entries.set(ev.id, en);
      this.add(el);
    }
    en.el.innerHTML = `<h4>Plan</h4><ul>${(ev.items || []).map((i) => `<li class="${i.done ? 'done' : ''}">${esc(i.text)}</li>`).join('')}</ul>`;
  }

  addTurn(ev) {
    const bits = [];
    if (ev.ms) bits.push(fmtMs(ev.ms));
    if (ev.steps > 1) bits.push(`${ev.steps} steps`);
    if (ev.cost) bits.push('$' + ev.cost.toFixed(3));
    if (ev.tokens && (ev.tokens.in || ev.tokens.out)) bits.push(`${Math.round((ev.tokens.in || 0) / 100) / 10}k in · ${Math.round((ev.tokens.out || 0) / 100) / 10}k out`);
    const el = document.createElement('div');
    el.className = 'turn' + (ev.ok === false ? ' bad' : '');
    el.textContent = (ev.ok === false ? '✕ failed' : '✓ done') + (bits.length ? ' · ' + bits.join(' · ') : '');
    this.entries.set(ev.id, { el });
    this.add(el);
  }

  addLine(cls, ev) {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = ev.text;
    this.entries.set(ev.id, { el });
    this.add(el);
  }

  // ------------------------------------------------------------ clicks inside the feed
  onFeedClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const card = b.closest('.m');
    if (act === 'copycode') {
      const code = b.closest('pre').querySelector('code')?.textContent ?? b.closest('pre').textContent.replace(/Copy$/, '');
      navigator.clipboard?.writeText(code);
      this.flash(b, 'Copied');
    } else if (act === 'copy') {
      const en = [...this.entries.values()].find((x) => x.el === card);
      navigator.clipboard?.writeText(en?.text || '');
      this.flash(b, 'Copied');
    } else if (act === 'fwd') {
      const en = [...this.entries.values()].find((x) => x.el === card);
      if (en?.text) this.h.forward(en.text);
    } else if (act === 'allow' || act === 'deny') {
      const en = [...this.entries.values()].find((x) => x.el === card);
      if (en?.data?.requestId) this.h.approve(en.data.requestId, act === 'allow');
    }
  }
  flash(btn, text) {
    const old = btn.textContent;
    btn.textContent = text;
    setTimeout(() => (btn.textContent = old), 1100);
  }

  snippet() {
    const last = [...this.entries.values()].reverse().find((x) => x.text);
    return last ? last.text.replace(/\s+/g, ' ').slice(0, 110) : '';
  }
}
