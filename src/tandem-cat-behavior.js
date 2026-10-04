// Pure behavior state machine. No renderer or timers; update with elapsed seconds.
const ONE_SHOTS = new Set(['WakeStretch', 'SettleSleep', 'Groom', 'Curious', 'Reposition']);
export const INK_CAT_LABELS = {
  Sleep: 'curled up asleep', Snuggle: 'snuggling', WakeStretch: 'waking and stretching',
  Idle: 'sitting upright', Groom: 'grooming', Curious: 'looking around',
  SettleSleep: 'curling up to sleep', Reposition: 'shifting places',
};

export function agentIsActive(state = {}) {
  return Boolean(state.busy || state.thinking || state.awaiting ||
    ['running', 'active', 'thinking', 'awaiting'].includes(state.status) ||
    state.moons?.length || state.tools?.running?.length);
}

export function createInkCatBrain({ kitten = false, random = Math.random, durations = {} } = {}) {
  let active = false, clip = kitten ? 'Snuggle' : 'Sleep', elapsed = 0;
  let nextIdle = 8 + random() * 10, requested = null;
  function choose(next) { clip = next; elapsed = 0; return next; }
  return {
    get active() { return active; },
    get clip() { return clip; },
    get label() { return INK_CAT_LABELS[clip]; },
    setActive(value) { active = Boolean(value); },
    request(name) {
      if (active && ['Groom', 'Curious', 'Reposition'].includes(name)) requested = name;
    },
    update(dt, { reducedMotion = false } = {}) {
      elapsed += Math.max(0, Math.min(.1, dt));
      const sleeping = kitten ? 'Snuggle' : 'Sleep';
      if (reducedMotion) {
        const next = active ? 'Idle' : sleeping;
        return clip === next ? null : choose(next);
      }
      if (active && (clip === 'Sleep' || clip === 'Snuggle' || clip === 'SettleSleep')) return choose('WakeStretch');
      if (!active && !['Sleep', 'Snuggle', 'SettleSleep'].includes(clip)) return choose('SettleSleep');
      if (ONE_SHOTS.has(clip) && elapsed >= (durations[clip] || (clip === 'WakeStretch' ? 4 : 3))) {
        nextIdle = 8 + random() * 12;
        return choose(active ? 'Idle' : sleeping);
      }
      if (active && clip === 'Idle' && (requested || elapsed >= nextIdle)) {
        const next = requested || (random() < .65 ? 'Groom' : 'Curious');
        requested = null;
        return choose(next);
      }
      if (!active) requested = null;
      return null;
    },
  };
}
