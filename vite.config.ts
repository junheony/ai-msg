import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  root: 'src/ui',
  define: { __DECK_VERSION__: JSON.stringify(version) },
  plugins: [react()],
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
    // React and the other deps (mostly react-markdown + remark-gfm) as separate chunks, each under the 500 kB warning.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
            { name: 'vendor', test: /node_modules[\\/]/ },
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:9320',
      '/ws': { target: 'ws://127.0.0.1:9320', ws: true },
    },
  },
});
