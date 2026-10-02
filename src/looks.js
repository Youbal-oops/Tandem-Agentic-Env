// Plain colour/look tables shared by the 3D scene and the text-only (lite) UI. No three.js here, so lite mode never loads it.
export const AGENT_LOOK = {
  claude: {
    name: 'Claude',
    hex: '#ffb25a',
    palette: ['#6b2a1c', '#e8663d', '#ffb25a', '#f8e6c4'],
    rim: '#ffb25a',
    style: 0,
    radius: 21,
    orbit: { a: 150, b: 138, tilt: 0.14, speed: 0.085, phase: 0.9 },
    spin: 0.18,
  },
  codex: {
    name: 'Codex',
    hex: '#74e6ff',
    palette: ['#05314a', '#1593b8', '#74e6ff', '#ecfdff'],
    rim: '#74e6ff',
    style: 1,
    radius: 18,
    orbit: { a: 245, b: 226, tilt: -0.11, speed: 0.052, phase: 4.1 },
    spin: 0.12,
  },
};
export const CLASS_COLORS = {
  read: '#6ea8ff',
  search: '#b18cff',
  shell: '#ff8a3d',
  edit: '#6ee7a0',
  web: '#4de3d3',
  mcp: '#ff7ad9',
  agent: '#ffffff',
  other: '#9aa3b8',
};
