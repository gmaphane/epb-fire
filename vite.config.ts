import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    preact(),
    VitePWA({
      registerType: 'prompt', // never reload the page mid-incident; the app shows an "update ready" toast
      includeAssets: ['icon.svg', 'push-sw.js'],
      manifest: {
        name: 'EPB Fire Response',
        short_name: 'EPB Fire',
        description: 'Fire prediction, detection, response and recording for EcoPlanet Bamboo',
        theme_color: '#133C34',
        background_color: '#F5F6F0',
        id: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,woff}'],
        navigateFallback: '/index.html',
        cleanupOutdatedCaches: true,
        importScripts: ['push-sw.js'], // fire alerts (push notifications)
      },
    }),
  ],
  build: { target: 'es2020', sourcemap: false },
  test: { environment: 'node', include: ['tests/*.test.ts'] },
});
