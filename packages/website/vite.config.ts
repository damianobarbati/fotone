import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { prerender } from './prerender.ts';

const root = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  root,
  base: './',
  plugins: [tailwindcss(), prerender({ root })],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rolldownOptions: {
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE' || !warning.message.includes('use client')) warn(warning);
      },
    },
  },
});
