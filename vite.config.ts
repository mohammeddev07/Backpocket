import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // GitHub Pages serves the repo under /Backpocket/. The manifest and share
  // target use relative paths, so they keep working under this base.
  base: '/Backpocket/',
  resolve: {
    alias: {
      // Prompts, schemas and limits shared with the Deno Edge Function.
      '@shared': fileURLToPath(new URL('./supabase/functions/_shared', import.meta.url)),
    },
  },
  plugins: [
    VitePWA({
      // Hand-written worker (src/sw.ts -> dist/sw.js, same URL as v1 so existing
      // registrations update in place). The plugin only injects the list of
      // hashed build files into self.__WB_MANIFEST; the worker doesn't use
      // Workbox at runtime, so its cache names and cleanup rules stay ours.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      // public/manifest.webmanifest is served as-is: its filename, id,
      // start_url, scope and share_target must not change.
      manifest: false,
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
      },
      devOptions: { enabled: false },
    }),
  ],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'supabase/functions/_shared/**/*.test.ts'],
  },
});
