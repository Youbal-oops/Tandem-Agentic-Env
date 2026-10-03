import { defineConfig } from 'vite';

// The browser only ever talks to one origin. In dev, Vite serves the UI on 5173 and
// forwards /api and /ws to the local Tandem server on 4317.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
      '/ws': { target: 'ws://127.0.0.1:4317', ws: true },
    },
  },
  build: { chunkSizeWarningLimit: 2000, rollupOptions: { input: { main: 'index.html', cats: 'cats.html' } } },
});
