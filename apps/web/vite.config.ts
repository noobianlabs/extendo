import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = process.env.EXTENDO_PORT ?? '4310';
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}` },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true },
    },
  },
});
