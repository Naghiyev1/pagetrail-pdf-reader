import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// For GitHub Pages project sites, set base to './' so assets load correctly
// regardless of the repository name.
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true
  }
});
