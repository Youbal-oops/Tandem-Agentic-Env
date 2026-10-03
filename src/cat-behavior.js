// Shared by the cat models and their accessible activity labels.
export function catActivity(state = {}) {
  if (state.awaiting || state.status === 'awaiting') return 'waiting';
  if (state.status === 'failed') return 'startled';
  const tools = state.moons || state.tools?.running || [];
  if (tools.includes('edit')) return 'kneading';
  if (tools.some((tool) => ['read', 'search', 'web'].includes(tool))) return 'watching';
  if (tools.length) return 'playing';
  if (state.thinking || state.busy || ['running', 'active', 'thinking'].includes(state.status)) return 'thinking';
  return 'sleeping';
}

export const CAT_LABELS = {
  sleeping: 'resting', thinking: 'thinking', kneading: 'coding · kneading',
  watching: 'reading · watching', playing: 'using a tool · playing',
  waiting: 'needs approval', startled: 'task failed', walking: 'wandering', snuggling: 'snuggling',
};

export function moveCat(cat, target, dt, speed = 22) {
  const distance = target - cat.x;
  cat.walking = Math.abs(distance) > 1.5;
  if (cat.walking) {
    cat.direction = distance < 0 ? -1 : 1;
    cat.x += Math.sign(distance) * Math.min(Math.abs(distance), speed * dt);
  }
}
