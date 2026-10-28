// Chat Completions services Tandem knows about, so a planet can be added in one click (or found automatically
// when its key is set). Every endpoint is the OpenAI-compatible one; `keyEnv` is the environment variable the
// server reads the key from. A service with no key is a local server that is simply running or not.

export const API_SERVICES = [
  { id: 'openrouter', name: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY' },
  { id: 'openai', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', keyEnv: 'OPENAI_API_KEY' },
  { id: 'anthropic', name: 'Anthropic API', endpoint: 'https://api.anthropic.com/v1/chat/completions', keyEnv: 'ANTHROPIC_API_KEY' },
  { id: 'google', name: 'Gemini API', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyEnv: 'GEMINI_API_KEY' },
  { id: 'groq', name: 'Groq', endpoint: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY' },
  { id: 'mistral', name: 'Mistral', endpoint: 'https://api.mistral.ai/v1/chat/completions', keyEnv: 'MISTRAL_API_KEY' },
  { id: 'deepseek', name: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', keyEnv: 'DEEPSEEK_API_KEY' },
  { id: 'xai', name: 'xAI', endpoint: 'https://api.x.ai/v1/chat/completions', keyEnv: 'XAI_API_KEY' },
  { id: 'together', name: 'Together AI', endpoint: 'https://api.together.xyz/v1/chat/completions', keyEnv: 'TOGETHER_API_KEY' },
  { id: 'ollama', name: 'Ollama (local)', endpoint: 'http://localhost:11434/v1/chat/completions', keyEnv: '' },
  { id: 'lmstudio', name: 'LM Studio (local)', endpoint: 'http://localhost:1234/v1/chat/completions', keyEnv: '' },
];

export const serviceById = (id) => API_SERVICES.find((s) => s.id === id) || null;

/** How many planet looks the 3D scene can draw (src/scene.js). New planets pick one at random. */
export const PLANET_STYLES = 6;
/** How many ring looks it can draw: 0 is no ring, 1 to 5 are different rings. */
export const PLANET_RINGS = 6;
