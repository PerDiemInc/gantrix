import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// The dashboard talks to the API through this proxy, so the browser only ever sees one origin.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', 'GANTRIX_');
  const api = `http://${env.GANTRIX_HOST ?? '127.0.0.1'}:${env.GANTRIX_PORT ?? '4700'}`;
  const proxy = { '/api': { target: api, changeOrigin: false } };
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', port: 4701, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4701, strictPort: true, proxy },
  };
});
