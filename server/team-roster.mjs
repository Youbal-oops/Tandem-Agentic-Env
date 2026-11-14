// The team as the Team chat sees it right now: each agent, whether it is free, its mode, and the models it offers.
// Used by the dispatcher, the coordinator and the plain rules, so all three look at the same facts.

import { agentBrief } from './team-handoff.mjs';

/**
 * `workspace` is the workspace API, `catalog` is { provider: [{ id, label, about }] } (see app/binaries.mjs), and `signedIn` is
 * { cli id: true | false | null } from the last sign-in check: a CLI that is known not to be signed in is not available, so
 * nothing is planned onto it. (Before this, an expired login was only found out by sending it a task that then failed.)
 */
export function buildRoster(workspace, catalog = {}, signedIn = () => ({})) {
  const signed = signedIn() || {};
  const snap = workspace.snapshot();
  return workspace.configs().map((c) => {
    const meta = snap[c.id]?.meta || {};
    return {
      id: c.id, name: c.name, provider: c.provider, models: catalog[c.provider] || [], fixedModel: c.provider === 'api' ? c.model : null,
      endpoint: c.endpoint, keyEnv: c.keyEnv,
      brief: agentBrief(snap[c.id]), // what it is doing, last did, and changed: the context the assistant routes by
      current: meta.modelPref || null, busy: !!meta.busy, available: meta.available !== false && signed[c.provider] !== false, mode: meta.mode, turns: meta.turns || 0,
    };
  });
}
