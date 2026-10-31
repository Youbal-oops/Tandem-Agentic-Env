// Settings that belong to the whole workspace and are saved in workspace.json. Each section is validated here,
// so the browser can only ever store values the server understands.

export const REVIEW_DEFAULTS = Object.freeze({ enabled: true, maxLines: 300, maxFiles: 10, hardStop: true, margin: 25 });
const int = (v, lo, hi, fallback) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fallback);

export function cleanReview(input, current = REVIEW_DEFAULTS) {
  const r = input && typeof input === 'object' ? input : {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : current.enabled,
    maxLines: int(r.maxLines, 20, 5000, current.maxLines),
    maxFiles: int(r.maxFiles, 1, 200, current.maxFiles),
    hardStop: typeof r.hardStop === 'boolean' ? r.hardStop : current.hardStop,
    margin: int(r.margin, 5, 100, current.margin),
  };
}

export const STRUCTURE_SETTINGS = Object.freeze({ enabled: false, minLines: 150, minGroups: 3 });
export function cleanStructure(input, current = STRUCTURE_SETTINGS) {
  const r = input && typeof input === 'object' ? input : {};
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : current.enabled,
    minLines: int(r.minLines, 40, 2000, current.minLines),
    minGroups: int(r.minGroups, 2, 20, current.minGroups),
  };
}

export const AGENT_DEFAULTS = Object.freeze({ pingMain: true, allowFull: false, tools: true });
export const cleanAgents = (input, current = AGENT_DEFAULTS) => ({
  pingMain: typeof input?.pingMain === 'boolean' ? input.pingMain : current.pingMain,
  allowFull: typeof input?.allowFull === 'boolean' ? input.allowFull : current.allowFull,
  tools: typeof input?.tools === 'boolean' ? input.tools : current.tools, // Tandem's browser, build and test tools for agents
});

export function createSettings({ saved }) {
  let review = cleanReview(saved.settings?.review);
  let agents = cleanAgents(saved.settings?.agents);
  let structure = cleanStructure(saved.settings?.structure);
  return {
    review: () => review,
    agents: () => agents,
    structure: () => structure,
    state: () => ({ review, agents, structure }),
    save(input) {
      if (!input || typeof input !== 'object') throw new Error('Invalid settings.');
      if (input.review !== undefined) review = cleanReview(input.review, review);
      if (input.agents !== undefined) agents = cleanAgents(input.agents, agents);
      if (input.structure !== undefined) structure = cleanStructure(input.structure, structure);
      return { review, agents, structure };
    },
  };
}
