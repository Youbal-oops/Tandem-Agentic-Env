// A scripted session so the whole interface can be tried without touching either CLI.
// It feeds the same events and stats the server would send.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const CLS = { Read: 'read', Grep: 'search', Bash: 'shell', Shell: 'shell', Edit: 'edit', Write: 'edit', Task: 'agent', WebFetch: 'web', 'github.search': 'mcp' };

export function createDemo({ handle, setMeta, fx, log }) {
  let alive = true;
  let n = 0;
  const id = (a, k) => `${a}:demo:${k}:${++n}`;
  const now = () => Math.floor(Date.now() / 1000);

  const S = {
    claude: {
      ctx: { used: 31000, window: 200000 },
      tokens: { fresh: 1200, cached: 48000, out: 3100, think: 900 },
      cache: 0.88,
      limits: { five: { u: 0.41, reset: now() + 9000 }, seven: { u: 0.84, reset: now() + 250000 } },
      tools: { total: 14, byClass: { read: 6, search: 3, shell: 3, edit: 2 }, running: [] },
      subagents: [],
      mcp: [
        { name: 'My Site', status: 'connected' },
        { name: 'Supabase', status: 'connected' },
        { name: 'Vercel', status: 'connected' },
        { name: 'Notion', status: 'pending' },
        { name: 'Gmail', status: 'needs-auth' },
      ],
      plan: [],
      touched: [],
      compactions: 0,
      errors: 0,
      denials: 0,
      thinking: false,
    },
    codex: {
      ctx: { used: 22000, window: 258400 },
      tokens: { fresh: 800, cached: 52000, out: 1900, think: 1400 },
      cache: 0.91,
      limits: { five: { u: 0.28, reset: now() + 11000 }, seven: { u: 0.2, reset: now() + 380000 } },
      tools: { total: 9, byClass: { shell: 6, edit: 1, read: 2 }, running: [] },
      subagents: [],
      mcp: [],
      plan: [],
      touched: [],
      compactions: 0,
      errors: 0,
      denials: 0,
      thinking: false,
    },
  };
  const push = (agent, extra = {}) => setMeta(agent, { stats: structuredClone(S[agent]), ...extra });
  const grow = (agent, tokens) => {
    S[agent].ctx.used += tokens;
    S[agent].tokens.fresh += Math.round(tokens * 0.04);
    S[agent].tokens.cached += Math.round(tokens * 0.6);
  };

  async function say(agent, text, speed = 22) {
    const mid = id(agent, 'm');
    handle(agent, { k: 'msg', id: mid, role: 'assistant', text: '', done: false });
    for (const w of text.split(/(\s+)/)) {
      if (!alive) return;
      handle(agent, { k: 'delta', id: mid, text: w });
      await wait(speed + Math.random() * 25);
    }
    handle(agent, { k: 'msg', id: mid, done: true });
    S[agent].tokens.out += Math.round(text.length / 4);
    grow(agent, Math.round(text.length / 3));
    push(agent);
  }

  async function think(agent, ms = 1100) {
    const tid = id(agent, 'k');
    S[agent].thinking = true;
    push(agent);
    handle(agent, { k: 'think', id: tid, text: 'Looking at how this is structured before changing anything.', done: false });
    await wait(ms);
    handle(agent, { k: 'think', id: tid, done: true });
    S[agent].thinking = false;
    S[agent].tokens.think += 300;
    push(agent);
  }

  async function tool(agent, name, summary, { ms = 900, detail, output, approve = false, fail = false, grows = 6000, cls } = {}) {
    const tid = id(agent, 't');
    const c = cls || CLS[name] || 'other';
    S[agent].tools.total += 1;
    S[agent].tools.byClass[c] = (S[agent].tools.byClass[c] || 0) + 1;
    S[agent].tools.running.push(c);
    handle(agent, { k: 'tool', id: tid, name, cls: c, summary, detail, status: approve ? 'awaiting' : 'running', requestId: approve ? tid : undefined, at: Date.now() });
    push(agent, approve ? { awaiting: 1 } : {});
    if (approve) {
      await wait(3600);
      handle(agent, { k: 'tool', id: tid, status: 'running' });
      push(agent, { awaiting: 0 });
    }
    await wait(ms);
    S[agent].tools.running.splice(S[agent].tools.running.indexOf(c), 1);
    grow(agent, grows);
    handle(agent, { k: 'tool', id: tid, name, cls: c, status: fail ? 'error' : 'done', output, ms });
    if (fail) {
      S[agent].errors += 1;
      fx(agent, 'error');
    }
    if (c === 'edit' && !fail) S[agent].touched.push({ p: summary.split(',')[0].replace(/^(add|update|delete) /, ''), n: 1 });
    push(agent);
  }

  async function turn(agent, ok = true, extra = {}) {
    handle(agent, { k: 'turn', id: id(agent, 'T'), ok, at: Date.now(), ...extra });
    setMeta(agent, { busy: false, turns: (S[agent].turns = (S[agent].turns || 0) + 1), cost: (S[agent].cost = (S[agent].cost || 0) + (extra.cost || 0)) });
    push(agent);
  }

  async function user(agent, text) {
    handle(agent, { k: 'user', id: id(agent, 'u'), text, at: Date.now() });
    setMeta(agent, { busy: true });
  }

  async function claudeScene() {
    setMeta('claude', { model: 'claude-opus-5-5', mode: 'ask', session: true });
    push('claude');
    await user('claude', 'Add a dark-mode toggle to the settings page, and keep everyone’s saved settings.');
    await wait(500);
    await think('claude');
    S.claude.plan = [
      { text: 'Find where settings live', done: false, active: true },
      { text: 'Add a theme field + persistence', done: false },
      { text: 'Build the toggle', done: false },
      { text: 'Run the tests', done: false },
    ];
    handle('claude', { k: 'plan', id: 'claude:plan', items: S.claude.plan });
    push('claude');
    await tool('claude', 'Grep', 'settings', { ms: 700, output: 'src/settings.js:12\nsrc/App.jsx:48', grows: 4000 });
    // a sub-agent goes off to explore
    const sid = id('claude', 'sub');
    S.claude.subagents = [{ id: sid, name: 'Explore: how is state persisted?', status: 'running' }];
    S.claude.tools.total += 1;
    S.claude.tools.byClass.agent = (S.claude.tools.byClass.agent || 0) + 1;
    handle('claude', { k: 'tool', id: sid, name: 'Task', cls: 'agent', summary: 'Explore: how is state persisted?', status: 'running', at: Date.now() });
    push('claude');
    await tool('claude', 'Read', 'src/settings.js', { ms: 700, grows: 9000 });
    await tool('claude', 'Read', 'src/storage.js', { ms: 600, grows: 7000 });
    await wait(900);
    S.claude.subagents = [{ id: sid, name: 'Explore: how is state persisted?', status: 'done' }];
    handle('claude', { k: 'tool', id: sid, status: 'done', output: 'Settings persist through useLocalStorage in storage.js.', ms: 3400 });
    S.claude.plan[0] = { text: S.claude.plan[0].text, done: true };
    S.claude.plan[1].active = true;
    handle('claude', { k: 'plan', id: 'claude:plan', items: S.claude.plan });
    push('claude');
    await say('claude', 'The settings page keeps its state in one `useSettings` hook, so the toggle fits there. I will add a `theme` field, persist it, and expose a switch in the panel.\n\n```js\nconst [theme, setTheme] = useLocalStorage("theme", "dark");\n```\n');
    await tool('claude', 'Edit', 'src/settings.js', {
      ms: 1100,
      approve: true,
      detail: { file_path: 'src/settings.js', old_string: 'const [sound, setSound] = useState(true);', new_string: 'const [sound, setSound] = useState(true);\n  const [theme, setTheme] = useLocalStorage("theme", "dark");' },
      output: 'The file src/settings.js has been updated.',
      grows: 11000,
    });
    S.claude.plan[1] = { text: S.claude.plan[1].text, done: true };
    S.claude.plan[2].active = true;
    handle('claude', { k: 'plan', id: 'claude:plan', items: S.claude.plan });
    await tool('claude', 'Bash', 'npm test -- settings', { ms: 1700, output: 'PASS  src/settings.test.js\n  ✓ persists the theme (12 ms)\n\nTests: 4 passed', grows: 8000 });
    S.claude.plan = S.claude.plan.map((p) => ({ text: p.text, done: true }));
    handle('claude', { k: 'plan', id: 'claude:plan', items: S.claude.plan });
    await say('claude', '**Done.** The toggle is in and the tests pass. I also kept the previous value as the default so nobody’s saved setting changes.');
    await turn('claude', true, { ms: 14200, steps: 5, cost: 0.083 });
    // the conversation keeps growing until the window is nearly full, then it is compacted
    await wait(2500);
    for (const step of [0.62, 0.74, 0.88, 0.95]) {
      if (!alive) return;
      S.claude.ctx.used = Math.round(S.claude.ctx.window * step);
      push('claude');
      await wait(1500);
    }
    S.claude.compactions += 1;
    S.claude.ctx.used = Math.round(S.claude.ctx.window * 0.14);
    fx('claude', 'compact');
    log({ agent: 'claude', kind: 'warn', text: 'context compacted' });
    handle('claude', { k: 'note', id: id('claude', 'n'), text: 'Context was compacted to make room.', at: Date.now() });
    push('claude');
  }

  async function codexScene() {
    setMeta('codex', { model: 'gpt-5-codex', mode: 'read', session: true });
    push('codex');
    await wait(2500);
    await user('codex', 'Review the diff Claude just made and run the full suite.');
    await wait(400);
    await think('codex', 900);
    await tool('codex', 'Shell', 'git diff --stat', { ms: 800, output: ' src/settings.js | 3 ++-\n 1 file changed, 2 insertions(+), 1 deletion(-)', grows: 3000 });
    await tool('codex', 'Shell', 'npm test', { ms: 2200, fail: true, output: 'FAIL  src/storage.test.js\n  ✕ falls back when localStorage throws\n\nTests: 1 failed, 40 passed', grows: 6000 });
    S.codex.plan = [{ text: 'Check the diff', done: true }, { text: 'Run the suite', done: true }, { text: 'Look into the failing test', done: false, active: true }];
    handle('codex', { k: 'plan', id: 'codex:plan', items: S.codex.plan });
    push('codex');
    await tool('codex', 'Shell', 'rg localStorage src', { ms: 900, output: 'src/storage.js:4: window.localStorage.getItem(key)', grows: 2000 });
    await say('codex', 'One test fails: if `localStorage` is unavailable (private mode) the hook throws instead of falling back to the default. The change itself is correct, and the other **40 tests pass**.');
    await turn('codex', true, { ms: 9800, tokens: { in: 24763, out: 612 } });
  }

  async function run() {
    await Promise.all([claudeScene(), codexScene()]);
  }

  async function respond(agent, text) {
    await user(agent, text);
    await wait(500);
    await think(agent, 800);
    await tool(agent, agent === 'claude' ? 'Read' : 'Shell', agent === 'claude' ? 'README.md' : 'ls', { ms: 800 });
    await say(agent, `This is a **demo reply**, so nothing was sent to ${agent === 'claude' ? 'Claude' : 'Codex'}. Run \`npm run dev\` and your message will go to the real CLI.`);
    await turn(agent, true, { ms: 2100 });
  }

  return {
    run,
    respond,
    stop() {
      alive = false;
    },
  };
}
