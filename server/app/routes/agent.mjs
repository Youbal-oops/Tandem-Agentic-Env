// Messages addressed to one agent (send, stop, mode, model, approve, implement ...) and compatible-API model discovery.

import { MAX_TEXT } from '../config.mjs';
import { listApiModels } from '../api-models.mjs';
import { pickAssignment } from '../../team.mjs';
import { DEFAULT_GUIDE } from '../../team-dispatch.mjs';

export function createAgentRoutes({ agents, hub, snapshot, modelCatalog = () => ({}), dispatcher = null }) {
  return {
    handlers: {
      /**
       * The Team chat: one task, no agent named (or one the user picked). Tandem chooses the agent and the model for the
       * task's size, sets that model, and sends the task to that agent's own chat. The answer says who got it and why.
       */
      'team-send': async (m, conn) => {
        const reply = (body) => conn.send({ t: 'team', request: m.request, ...body });
        const text = typeof m.text === 'string' ? m.text.trim() : '';
        if (!text) return reply({ error: 'Write a task first.' });
        if (text.length > MAX_TEXT) return reply({ error: 'Shorten the task to 40,000 characters.' });
        try {
          const snap = agents.snapshot();
          const catalog = modelCatalog();
          const list = agents.configs().map((c) => {
            const meta = snap[c.id]?.meta || {};
            return { id: c.id, name: c.name, provider: c.provider, models: catalog[c.provider] || [], fixedModel: c.provider === 'api' ? c.model : null,
              endpoint: c.endpoint, keyEnv: c.keyEnv,
              current: meta.modelPref || null, busy: !!meta.busy, available: meta.available !== false, mode: meta.mode, turns: meta.turns || 0 };
          });
          const want = { agent: typeof m.agent === 'string' && m.agent ? m.agent : undefined, tier: m.tier };
          // The rules always run first: they catch "nobody is free" at once, and they are the answer if the dispatcher has none.
          let pick = pickAssignment({ text, agents: list, want });
          if (pick.error) return reply({ error: pick.error });
          const team = agents.settings().team || { dispatcher: 'auto', guide: '' };
          const decided = want.agent && want.tier; // the user chose both: nothing left to decide
          if (dispatcher && team.dispatcher !== 'rules' && !decided) {
            const { decision, by, why } = await dispatcher.decide({ guide: team.guide || DEFAULT_GUIDE, agents: list, text, want, pin: team.dispatcher,
              onTry: (who) => conn.send({ t: 'team', request: m.request, progress: `Asking the dispatcher (${who.name} on ${who.modelLabel})…` }) });
            // The team may have changed while the dispatcher was thinking: its choice must still be free.
            const still = decision && agents.snapshot()[decision.agent]?.meta;
            if (decision && still && !still.busy) {
              const rules = pick;
              pick = { agent: decision.agent, name: decision.name, model: decision.model, modelLabel: decision.modelLabel, tier: decision.size, kind: rules.kind,
                reason: decision.reason || `${decision.size} task.`, by: `Chosen by the dispatcher: ${by.name} on ${by.modelLabel}`,
                note: rules.agent === decision.agent ? rules.note : '' };
              const chosenNow = list.find((a) => a.id === pick.agent);
              if (rules.kind === 'change' && chosenNow.provider === 'api') pick.note = `${chosenNow.name} is a chat-only model: it can advise, but it cannot change files.`;
              else if (rules.kind === 'change' && ['plan', 'read'].includes(chosenNow.mode)) pick.note = `${chosenNow.name} is in a read-only mode, so it will propose the change, not make it. Switch its mode to let it edit.`;
            } else pick.by = `Chosen by Tandem's rules (${why || 'the dispatcher chose an agent that is no longer free'})`;
          } else pick.by = decided ? 'Your choice' : "Chosen by Tandem's rules";
          const chosen = list.find((a) => a.id === pick.agent);
          if (pick.model && pick.model !== chosen.current) await agents.action({ t: 'model', agent: pick.agent, model: pick.model });
          await agents.action({ t: 'send', agent: pick.agent, text });
          reply({ assignment: pick });
        } catch (e) { reply({ error: e.message }); }
      },
      /** Ask a Chat Completions endpoint which models it offers. */
      apimodels: async (m, conn) => {
        try {
          conn.send({ t: 'apimodels', models: await listApiModels(m.endpoint, m.keyEnv) });
        } catch (e) { conn.send({ t: 'apimodels', error: e.message }); }
      },
    },
    /** Anything else that names an agent goes to that agent. */
    async fallback(m) {
      if (typeof m.agent !== 'string') return false;
      if (m.t === 'send' && (typeof m.text !== 'string' || m.text.length > MAX_TEXT)) return;
      await agents.action(m);
      if (m.t === 'newchat') hub.broadcast(snapshot());
    },
  };
}
