// Messages addressed to one agent (send, stop, mode, model, approve, implement ...) and compatible-API model discovery.

import { MAX_TEXT } from '../config.mjs';
import { listApiModels } from '../api-models.mjs';
import { classifyTask, isFollowUp, pickAssignment } from '../../team.mjs';
import { buildRoster } from '../../team-roster.mjs';
import { DEFAULT_GUIDE } from '../../team-dispatch.mjs';
import { composeHandoff, combineAnswer } from '../../team-handoff.mjs';

export function createAgentRoutes({ agents, hub, snapshot, modelCatalog = () => ({}), dispatcher = null, coordinator = null, holds = null, signedIn = () => ({}) }) {
  return {
    handlers: {
      /** The Team chat of the open repository, saved on the server so it is there after a restart. */
      'team-load': (m, conn) => conn.send({ t: 'team-chat', ...agents.teamChat(), held: holds?.ids() || [] }),
      /** Stop a running plan, or run one task of it again. */
      'team-stop': (m) => { coordinator?.stop(String(m.runId)); },
      'team-retry': (m) => { coordinator?.retry(String(m.runId), String(m.taskId)); },
      /** Cancel a message the assistant is holding for a busy agent. */
      'team-unhold': (m, conn) => { if (holds?.cancel(String(m.entryId))) conn.send({ t: 'team', entryId: String(m.entryId), error: 'Cancelled: the held message was not sent.' }); },
      'team-save': (m, conn) => { agents.saveTeamChat(typeof m.cwd === 'string' ? m.cwd : '', m.entries); },
      /**
       * The Team chat: one task, no agent named (or one the user picked). Tandem chooses the agent and the model for the
       * task's size, sets that model, and sends the task to that agent's own chat. The answer says who got it and why.
       */
      'team-send': async (m, conn) => {
        const reply = (body) => conn.send({ t: 'team', request: m.request, ...body });
        let text = typeof m.text === 'string' ? m.text.trim() : '';
        if (!text) return reply({ error: 'Write a task first.' });
        if (text.length > MAX_TEXT) return reply({ error: 'Shorten the task to 40,000 characters.' });
        try {
          const list = buildRoster(agents, modelCatalog(), signedIn);
          const want = { agent: typeof m.agent === 'string' && m.agent ? m.agent : undefined, tier: m.tier };
          // The rules always run first: they catch "nobody is free" at once, and they are the answer if the dispatcher has none.
          // The last few Team messages, for follow-ups. They come from this browser, so only short plain strings are kept.
          const all = (Array.isArray(m.recent) ? m.recent : []).slice(-3).filter((r) => r && typeof r.text === 'string');
          // The user is answering a question the assistant asked: the request and the answer are routed together.
          if (m.answering && all.length && typeof all[all.length - 1].asked === 'string') {
            const joined = combineAnswer(all[all.length - 1], text);
            if (joined) { text = joined.slice(0, MAX_TEXT); all.pop(); }
          }
          const recent = all.filter((r) => typeof r.agent === 'string' && list.some((a) => a.id === r.agent))
            .map((r) => ({ text: r.text.slice(0, 600), agent: r.agent, result: typeof r.result === 'string' ? r.result.slice(0, 400) : '' }));
          const team = agents.settings().team || { dispatcher: 'auto', guide: '', mode: 'dispatcher' };
          // A request with some substance, and no agent or size chosen by the user, goes to the coordinator: it plans, assigns and runs the work.
          // A small or quick one, a follow-up that belongs to one agent's conversation, and anything the user steered, skip the plan.
          let plannedWhy = '';
          if (coordinator && team.mode === 'coordinator' && !want.agent && !want.tier && !isFollowUp(text, recent) && classifyTask(text).tier !== 'light') {
            const out = await coordinator.plan({ text, recent, onProgress: (by) => conn.send({ t: 'team', request: m.request, progress: `Planning with ${by.name} on ${by.modelLabel}…` }) });
            if (out.run) return reply({ run: out.run });
            plannedWhy = out.fallback || '';
          }
          let pick = pickAssignment({ text, agents: list, want, recent });
          // Nobody free is not the end when the assistant may choose to wait for the agent that has the context.
          const canWait = !!(dispatcher && holds && team.dispatcher !== 'rules' && team.mode !== 'rules' && !want.agent);
          const noneFree = pick.error;
          if (noneFree && !canWait) return reply({ error: noneFree });
          if (noneFree) pick = {};
          let handoff = [];
          const decided = want.agent && want.tier; // the user chose both: nothing left to decide
          if (dispatcher && team.dispatcher !== 'rules' && team.mode !== 'rules' && !decided) {
            const { decision, by, why } = await dispatcher.decide({ guide: team.guide || DEFAULT_GUIDE, agents: list, text, want, recent, pin: team.dispatcher,
              onTry: (who) => conn.send({ t: 'team', request: m.request, progress: `Asking the assistant (${who.name} on ${who.modelLabel})…` }) });
            if (decision?.ask) return reply({ asked: decision.ask, by: `${by.name} on ${by.modelLabel}` });
            // The team may have changed while the dispatcher was thinking: its choice must still be free.
            const still = decision && agents.snapshot()[decision.agent]?.meta;
            if (decision && still && (!still.busy || (decision.wait && canWait))) {
              const rules = pick;
              handoff = decision.handoff || [];
              pick = { agent: decision.agent, name: decision.name, model: decision.model, modelLabel: decision.modelLabel, tier: decision.size, kind: rules.kind,
                reason: decision.reason || `${decision.size} task.`, by: `Chosen by the assistant: ${by.name} on ${by.modelLabel}`, followUp: rules.followUp && rules.agent === decision.agent,
                note: rules.agent === decision.agent ? rules.note : '' };
              if (decision.wait && still.busy) { // it has the context: hold the message and send it when that agent finishes
                const id = String(m.entryId || m.request);
                holds.add({ id, agent: pick.agent, name: pick.name, model: pick.model, modelLabel: pick.modelLabel, tier: pick.tier, reason: pick.reason, by: pick.by, text, handoff });
                return reply({ assignment: { ...pick, held: true, handoff: undefined } });
              }
              const chosenNow = list.find((a) => a.id === pick.agent);
              if (rules.kind === 'change' && chosenNow.provider === 'api') pick.note = `${chosenNow.name} is a chat-only model: it can advise, but it cannot change files.`;
              else if (rules.kind === 'change' && ['plan', 'read'].includes(chosenNow.mode)) pick.note = `${chosenNow.name} is in a read-only mode, so it will propose the change, not make it. Switch its mode to let it edit.`;
            } else pick.by = `Chosen by Tandem's rules (${why || 'the dispatcher chose an agent that is no longer free'})`;
          } else pick.by = decided ? 'Your choice' : `Chosen by Tandem's rules${plannedWhy ? ` (the coordinator could not plan: ${plannedWhy})` : ''}`;
          if (!pick.agent) return reply({ error: noneFree || 'No agent could take this.' });
          const chosen = list.find((a) => a.id === pick.agent);
          if (pick.model && pick.model !== chosen.current) await agents.action({ t: 'model', agent: pick.agent, model: pick.model });
          // Work that builds on another agent's comes with that agent's task, files and latest answer, read from their own chats.
          const carried = handoff.length ? composeHandoff({ handoff, roster: list, sharedDir: agents.sharedDir?.() || '' }) : null;
          if (carried) pick.handoff = carried.from.map((f) => ({ id: f.id, name: f.name, why: f.why }));
          await agents.action({ t: 'send', agent: pick.agent, text: carried ? `${carried.text}
${text}` : text });
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
