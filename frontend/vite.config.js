import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // index.html uses %VITE_APP_TITLE%: the store's name in a store's own build
  // (templates/store-app sets VITE_BRAND_NAME), the platform name otherwise.
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  process.env.VITE_APP_TITLE = (env.VITE_BRAND_NAME || '').trim() || 'SAFE Stores — Enterprise Inventory System';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: {
        '/api': 'http://localhost:4000',
        '/uploads': 'http://localhost:4000',
        '/socket.io': { target: 'http://localhost:4000', ws: true },
      },
    },
  };
});
