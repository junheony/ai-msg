import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/ui',
  plugins: [react()],
  build: { outDir: '../../dist/ui', emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:9320',
      '/ws': { target: 'ws://127.0.0.1:9320', ws: true },
    },
  },
});
