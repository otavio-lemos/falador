import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // host zero-dep na 8787 (catálogo, run NDJSON→SSE, save/load de flows)
      '/api': 'http://127.0.0.1:8787',
    },
  },
});
