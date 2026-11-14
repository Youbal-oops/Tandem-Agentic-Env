// Messages the Team assistant is holding for a busy agent: work that belongs with that agent because it did the earlier work and has the
// context for it. The message is sent when the agent finishes, so the user does not have to come back and repeat it.

import { composeHandoff } from './team-handoff.mjs';

export function createHolds({ workspace, getRoster, emit = () => {}, schedule = setTimeout, every = setInterval, now = Date.now, coolMs = 1500 }) {
  const holds = new Map(); // entry id -> { id, agent, name, model, modelLabel, text, handoff, idleSince }

  /** Hold `text` for `agent` until it is free. */
  function add(h) { holds.set(h.id, { ...h, idleSince: 0 }); }
  const cancel = (id) => holds.delete(id);
  const has = (id) => holds.has(id);
  const ids = () => [...holds.keys()];
  const waitingFor = (agent) => [...holds.values()].some((h) => h.agent === agent);

  async function release(h) {
    holds.delete(h.id);
    try {
      const roster = getRoster();
      const a = roster.find((x) => x.id === h.agent);
      if (!a || !a.available) throw new Error(`${h.name} is no longer available, so the held message was not sent. Send it again.`);
      if (h.model && h.model !== a.current) await workspace.action({ t: 'model', agent: h.agent, model: h.model });
      const carried = h.handoff?.length ? composeHandoff({ handoff: h.handoff, roster, sharedDir: workspace.sharedDir?.() || '' }) : null;
      await workspace.action({ t: 'send', agent: h.agent, text: carried ? `${carried.text}\n${h.text}` : h.text });
      emit({ t: 'team', entryId: h.id, released: { agent: h.agent, name: h.name, model: h.model, modelLabel: h.modelLabel, tier: h.tier, reason: h.reason, by: h.by, handoff: carried ? carried.from : undefined, held: undefined } });
    } catch (e) { emit({ t: 'team', entryId: h.id, error: e.message }); }
  }

  /** Send every held message whose agent has been idle for a moment (its CLI is still shutting down right after a turn). */
  function tick() {
    for (const h of [...holds.values()]) {
      const meta = workspace.snapshot()[h.agent]?.meta;
      if (!meta || meta.busy) { h.idleSince = 0; continue; }
      if (!h.idleSince) { h.idleSince = now(); schedule(tick, coolMs + 25); continue; }
      if (now() - h.idleSince >= coolMs) release(h);
    }
  }

  function observe(msg) { if (msg?.t === 'meta' && msg.meta && !msg.meta.busy && waitingFor(msg.agent)) tick(); }
  const poll = every(tick, 3000);
  return { add, cancel, has, ids, observe, tick, close() { clearInterval(poll); } };
}
