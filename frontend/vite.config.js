import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../backend/public',
    emptyOutDir: true,
    // React in its own chunk, so its hash (and the browser's cached copy) survives deploys that
    // only change application code. Vite 8 bundles with Rolldown, which has no object form of
    // Rollup's `manualChunks` ({ vendor: ['react', 'react-dom'] }) - the same split is a
    // codeSplitting group. `scheduler` is react-dom's dependency, which the object form pulled
    // into the chunk implicitly.
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
