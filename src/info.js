// The right-hand column: what the agents are using up, what they are doing, and the state of the project.

import { CLASS_COLORS } from './looks.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const HEX = { claude: '#ffb25a', codex: '#74e6ff' };
const NAME = { claude: 'Claude', codex: 'Codex' };
const CLASS_LABEL = { read: 'read', search: 'search', shell: 'shell', edit: 'edit', web: 'web', mcp: 'mcp', agent: 'agent', other: 'other' };

export const fmtK = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n || 0)));
function until(epochSec) {
  if (!epochSec) return '';
  const s = Math.round(epochSec - Date.now() / 1000);
  if (s <= 0) return 'resetting';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const level = (f) => (f >= 0.85 ? 'crit' : f >= 0.6 ? 'warn' : 'ok');

export class InfoPanel {
  constructor(root, { onSelect }) {
    this.root = root;
    this.onSelect = onSelect;
    this.sel = null;
    this.m = { claude: null, codex: null };
    this.hist = { claude: [], codex: [] };
    this.git = null;
    this.kids = {};
    this.logCount = 0;
    this.queued = false;

    root.innerHTML = `
      <div class="kicker">Horizon <span class="dot">·</span> <span id="r-focus">system overview</span></div>
      <h2 id="r-title">The <em>codebase</em></h2>
      <p class="blurb" id="r-blurb"></p>
      <div id="r-body"></div>
      <div class="kicker log-k">Log <span class="legend"><button data-f="all" class="on">all</button><button data-f="claude">claude</button><button data-f="codex">codex</button></span></div>
      <div id="r-log" class="logbox"></div>`;
    this.body = root.querySelector('#r-body');
    this.logBox = root.querySelector('#r-log');
    this.filter = 'all';
    root.querySelectorAll('.legend button').forEach((b) =>
      b.addEventListener('click', () => {
        this.filter = b.dataset.f;
        root.querySelectorAll('.legend button').forEach((x) => x.classList.toggle('on', x === b));
        this.logBox.dataset.filter = this.filter;
      }),
    );
    this.logBox.dataset.filter = 'all';
    this.logBox.addEventListener('click', (e) => {
      const line = e.target.closest('.ln');
      if (line) this.onSelect(line.dataset.agent);
    });
    this.body.addEventListener('click', (e) => {
      const a = e.target.closest('[data-pick]');
      if (a) this.onSelect(a.dataset.pick);
    });
    setInterval(() => this.render(), 15000); // reset countdowns
    this.render();
  }

  setSelected(id) {
    this.sel = id;
    this.render();
  }
  setMeta(id, meta) {
    this.hist[id] ||= [];
    const prev = this.m[id]?.stats?.ctx;
    this.m[id] = meta;
    const c = meta.stats?.ctx;
    if (c && c.window && (!prev || prev.used !== c.used)) {
      this.hist[id].push(Math.min(1, c.used / c.window));
      if (this.hist[id].length > 60) this.hist[id].shift();
    }
    this.queue();
  }
  setChildren(id, kids) {
    this.kids[id] = kids;
    // A subagent's context graph is built the same way as a main agent's, from each change in its usage.
    for (const k of kids) {
      const c = k.ctx;
      const h = (this.hist[`kid:${k.id}`] ||= []);
      if (c?.window && Math.min(1, c.used / c.window) !== h.at(-1)) { h.push(Math.min(1, c.used / c.window)); if (h.length > 60) h.shift(); }
    }
    const live = new Set(Object.values(this.kids).flat().map((k) => `kid:${k.id}`));
    for (const key of Object.keys(this.hist)) if (key.startsWith('kid:') && !live.has(key)) delete this.hist[key];
    this.queue();
  }
  setGit(git) {
    this.git = git;
    this.queue();
  }
  setAgents(configs, looks) {
    this.ids = configs.map((a) => a.id);
    for (const a of configs) { NAME[a.id] = a.name; HEX[a.id] = looks[a.id].hex; this.hist[a.id] ||= []; }
    for (const id of Object.keys(this.m)) if (!this.ids.includes(id)) delete this.m[id];
    this.queue();
  }
  /** Redraw soon, but at most four times a second: meta updates arrive many times a second while an agent streams. */
  queue() {
    if (this.queued) return;
    this.queued = true;
    const wait = Math.max(0, 250 - (performance.now() - (this.lastRender || 0)));
    setTimeout(() => requestAnimationFrame(() => {
      this.queued = false;
      this.render();
    }), wait);
  }

  // ------------------------------------------------------------ log
  log({ agent, text, kind = 'info', at = Date.now() }) {
    const t = new Date(at);
    const ts = t.toTimeString().slice(0, 8);
    const el = document.createElement('div');
    el.className = `ln ${kind}`;
    el.dataset.agent = agent;
    el.style.setProperty('--c', HEX[agent]);
    el.innerHTML = `<time>${ts}</time><i></i><b>${esc(NAME[agent])}</b><span>${esc(text)}</span>`;
    const stick = this.logBox.scrollHeight - this.logBox.scrollTop - this.logBox.clientHeight < 40;
    this.logBox.appendChild(el);
    while (this.logBox.children.length > 240) this.logBox.firstChild.remove();
    if (stick) this.logBox.scrollTop = this.logBox.scrollHeight;
  }
  clearLog() {
    this.logBox.textContent = '';
  }

  // ------------------------------------------------------------ rendering
  bar(f, extra = '') {
    const pct = Math.max(0, Math.min(1, f || 0));
    return `<div class="bar ${level(pct)}"><u style="width:${(pct * 100).toFixed(1)}%"></u><s></s>${extra}</div>`;
  }

  spark(id, hex = HEX[id]) {
    const h = this.hist[id];
    if (!h || h.length < 2) return '';
    const w = 90;
    const ht = 20;
    const pts = h.map((v, i) => `${((i / (h.length - 1)) * w).toFixed(1)},${(ht - 2 - v * (ht - 4)).toFixed(1)}`).join(' ');
    return `<svg class="hs" viewBox="0 0 ${w} ${ht}" width="${w}" height="${ht}"><polyline points="${pts}" fill="none" stroke="${hex}" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }

  /** One context graph per running subagent, shown under its main agent in the same style. */
  kidGauges(id) {
    return (this.kids[id] || [])
      .filter((k) => k.busy)
      .map((k) => {
        const hex = HEX[k.provider] || HEX[id];
        const c = k.ctx;
        const f = c?.window ? c.used / c.window : 0;
        return `<div class="grow kid ${this.sel === id ? 'sel' : ''}" data-pick="${id}" style="--c:${hex}" title="${esc(`${NAME[k.provider] || k.provider} subagent · ${k.title}`)}">
          <div class="gh"><i></i><b>${esc(NAME[k.provider] || k.provider)}</b><small>${esc(k.title)}</small><span>${c ? `${fmtK(c.used)} / ${fmtK(c.window)}` : 'starting…'}</span><em class="${level(f)}">${c ? Math.round(f * 100) + '%' : ''}</em></div>
          ${this.bar(f)}
          <div class="gf"><span>subagent${k.cache ? ' · cache hit ' + Math.round(k.cache * 100) + '%' : ''}</span>${this.spark(`kid:${k.id}`, hex)}</div>
        </div>`;
      })
      .join('');
  }

  gauges() {
    const rows = (this.ids || ['claude', 'codex'])
      .map((id) => {
        const m = this.m[id];
        const c = m?.stats?.ctx;
        const f = c && c.window ? c.used / c.window : 0;
        const cache = m?.stats?.cache;
        return `<div class="grow ${this.sel === id ? 'sel' : ''}" data-pick="${id}" style="--c:${HEX[id]}">
          <div class="gh"><i></i><b>${esc(NAME[id])}</b><span>${c ? `${fmtK(c.used)} / ${fmtK(c.window)}` : '—'}</span><em class="${level(f)}">${c ? Math.round(f * 100) + '%' : ''}</em></div>
          ${this.bar(f)}
          <div class="gf"><span>${cache ? 'cache hit ' + Math.round(cache * 100) + '%' : ''}</span>${this.spark(id)}</div>
        </div>${this.kidGauges(id)}`;
      })
      .join('');
    return `<div class="kicker">Context window</div>${rows}`;
  }

  limits() {
    const rows = (this.ids || ['claude', 'codex'])
      .map((id) => {
        const l = this.m[id]?.stats?.limits || {};
        const one = (label, x) =>
          `<div class="lrow"><span class="ll">${label}</span>${x ? this.bar(x.u) : '<div class="bar"><s></s></div>'}<span class="lv ${x ? level(x.u) : ''}">${x ? Math.round(x.u * 100) + '%' : '—'}</span><span class="lr">${x ? until(x.reset) : ''}</span></div>`;
        return `<div class="lgroup ${this.sel === id ? 'sel' : ''}" data-pick="${id}" style="--c:${HEX[id]}"><div class="lt"><i></i>${esc(NAME[id])}</div>${one('5h', l.five)}${one('7d', l.seven)}</div>`;
      })
      .join('');
    return `<div class="kicker">Usage limits <span class="hint">subscription windows</span></div>${rows}`;
  }

  tools(id) {
    const m = this.m[id];
    const s = m?.stats;
    if (!s) return '';
    const by = s.tools?.byClass || {};
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const seg = Object.entries(by)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `<u style="width:${(n / total) * 100}%;background:${CLASS_COLORS[k] || CLASS_COLORS.other}" title="${CLASS_LABEL[k] || k}: ${n}"></u>`)
      .join('');
    const legend = Object.entries(by)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `<span><i style="background:${CLASS_COLORS[k] || CLASS_COLORS.other}"></i>${CLASS_LABEL[k] || k} ${n}</span>`)
      .join('');
    return `<div class="mix">${seg || '<s></s>'}</div><div class="mixl">${legend || '<span class="dim">no tools used yet</span>'}</div>`;
  }

  agentDetail(id) {
    const m = this.m[id];
    const s = m?.stats;
    const t = s?.tokens || {};
    const out = [];
    out.push(`<div class="kicker" style="--c:${HEX[id]}"><span class="kc"><i></i>${esc(NAME[id])}</span><span class="hint">${m?.model ? esc(String(m.model).replace(/^claude-/, '')) : 'session'}</span></div>`);
    out.push(`<div class="stats">
      <div><b>${m?.cost ? '$' + m.cost.toFixed(m.cost < 1 ? 3 : 2) : '—'}</b><span>cost</span></div>
      <div><b>${m?.turns || 0}</b><span>turns</span></div>
      <div><b>${fmtK((t.fresh || 0) + (t.cached || 0))}</b><span>tokens in</span></div>
      <div><b>${fmtK(t.out || 0)}</b><span>tokens out</span></div>
      <div><b>${fmtK(t.think || 0)}</b><span>thinking</span></div>
      <div><b>${s?.tools?.total || 0}</b><span>tool calls</span></div>
    </div>`);
    out.push(this.tools(id));
    const subs = [...(s?.subagents || []), ...(this.kids[id] || []).map((k) => ({ name: `${NAME[k.provider] || k.provider} · ${k.title}`, status: k.busy ? 'running' : k.status === 'failed' ? 'failed' : 'done' }))];
    if (subs.length) out.push(`<div class="sub-k">Sub-agents</div>` + subs.map((a) => `<div class="li ${a.status}"><i></i><span>${esc(a.name)}</span><em>${esc(a.status || '')}</em></div>`).join(''));
    const plan = s?.plan || [];
    if (plan.length) out.push(`<div class="sub-k">Plan <em>${plan.filter((x) => x.done).length}/${plan.length}</em></div>` + plan.map((p) => `<div class="li plan ${p.done ? 'done' : p.active ? 'active' : ''}"><i></i><span>${esc(p.text)}</span></div>`).join(''));
    const mcp = s?.mcp || [];
    if (mcp.length) out.push(`<div class="sub-k">MCP servers <em>${mcp.filter((x) => x.status === 'connected').length}/${mcp.length} up</em></div><div class="chips">${mcp.map((x) => `<span class="chip ${x.status}" title="${esc(x.status)}"><i></i>${esc(x.name)}</span>`).join('')}</div>`);
    const touched = s?.touched || [];
    if (touched.length) out.push(`<div class="sub-k">Files edited this session</div>` + touched.slice().reverse().slice(0, 6).map((f) => `<div class="li file"><i></i><span>${esc(f.p)}</span><em>${f.n > 1 ? '×' + f.n : ''}</em></div>`).join(''));
    const flags = [];
    if (s?.compactions) flags.push(`${s.compactions} compaction${s.compactions > 1 ? 's' : ''}`);
    if (s?.errors) flags.push(`${s.errors} error${s.errors > 1 ? 's' : ''}`);
    if (s?.denials) flags.push(`${s.denials} denied`);
    if (flags.length) out.push(`<div class="flags">${flags.map((f) => `<span>${f}</span>`).join('')}</div>`);
    return `<section class="agent-detail" style="--c:${HEX[id]}">${out.join('')}</section>`;
  }

  project() {
    const g = this.git;
    if (!g) return `<div class="kicker">Project</div><p class="dim">Waiting for the server…</p>`;
    const sync = [g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
    const scripts = (g.pkg?.scripts || []).map((s) => `<span class="chip"><code>npm run ${esc(s)}</code></span>`).join('');
    const files = (g.files || [])
      .slice(0, 9)
      .map((f) => `<div class="li file st-${f.s}"><b>${esc(f.s)}</b><span title="${esc(f.p)}">${esc(f.p)}</span><em>${f.add || f.del ? `<ins>+${f.add}</ins> <del>−${f.del}</del>` : ''}</em></div>`)
      .join('');
    const more = (g.files?.length || 0) > 9 ? `<div class="dim more">+ ${g.files.length - 9} more</div>` : '';
    const commits = (g.commits || [])
      .slice(0, 5)
      .map((c) => `<div class="li commit"><code>${esc(c.h)}</code><span title="${esc(c.s)}">${esc(c.s)}</span><em>${esc(c.t)}</em></div>`)
      .join('');
    return `<div class="kicker">Project <span class="hint">${esc(g.repo)}${g.pkg?.version ? ' v' + esc(g.pkg.version) : ''}</span></div>
      <div class="branch"><b>⎇ ${esc(g.branch || '—')}</b>${sync ? `<span>${sync}</span>` : ''}<em>${g.changed ? g.changed + ' changed' : 'clean'}</em></div>
      ${scripts ? `<div class="chips">${scripts}</div>` : ''}
      ${files ? `<div class="sub-k">Changed files</div>${files}${more}` : ''}
      ${commits ? `<div class="sub-k">Recent commits</div>${commits}` : ''}`;
  }

  render() {
    const sel = this.sel;
    this.root.querySelector('#r-focus').textContent = sel ? `following ${esc(NAME[sel])}` : 'system overview';
    this.root.querySelector('#r-title').innerHTML = sel ? `<em style="color:${HEX[sel]}">${esc(NAME[sel])}</em>,<br />up close` : `The <em>codebase</em>`;
    const busy = (this.ids || ['claude', 'codex']).filter((a) => this.m[a]?.busy || (this.kids[a] || []).some((k) => k.busy)).map((a) => NAME[a]);
    this.root.querySelector('#r-blurb').textContent = busy.length
      ? `${busy.join(' and ')} ${busy.length > 1 ? 'are' : 'is'} working right now.`
      : 'do fish live in space?.';
    const detail = sel ? this.agentDetail(sel) : (this.ids || ['claude', 'codex']).map((a) => this.agentDetail(a)).join('');
    const html = this.gauges() + this.limits() + detail + `<section class="project">${this.project()}</section>`;
    this.lastRender = performance.now();
    if (html === this.lastHtml) return; // nothing changed: leave the DOM (and the scroll position) alone
    this.lastHtml = html;
    this.body.innerHTML = html;
  }
}
