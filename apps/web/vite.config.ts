import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // SCSS do Carbon referencia as fontes IBM Plex com prefixo webpack '~' — o Vite precisa do alias.
      '~@ibm/plex': fileURLToPath(new URL('./node_modules/@ibm/plex', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      // host zero-dep na 8787 (catálogo, run NDJSON→SSE, save/load de flows)
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
