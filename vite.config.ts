import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, '.', '');
  const apiTarget = environment.VITE_API_PROXY_TARGET ?? 'http://127.0.0.1:8000';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target: apiTarget, ws: true },
      },
    },
    test: {
      environment: 'jsdom',
    },
  };
});
