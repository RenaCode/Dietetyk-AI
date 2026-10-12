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
    // The browser floor Vite 6 built for (its 'modules' default). Vite 8's default is
    // 'baseline-widely-available' - Chrome 111, Firefox 114, Safari/iOS 16.4 - and it shows
    // in the CSS too (build.cssTarget follows build.target): media queries came out in the
    // range syntax `(width<=767px)`, which Safari before 16.4 ignores, so the whole responsive
    // layout would fall apart on an older iPhone. Kept until we decide to drop those devices.
    target: ['es2020', 'edge88', 'firefox78', 'chrome87', 'safari14'],
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
