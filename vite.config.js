import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: {
    port: 3000,
    open: true
  },
  esbuild: {
    drop: ['debugger'],
    legalComments: 'none',
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    chunkSizeWarningLimit: 600,
    cssCodeSplit: true,
    reportCompressedSize: true,
    rollupOptions: {
      input: {
        main:   resolve(__dirname, 'index.html'),
        admin:  resolve(__dirname, 'admin.html'),
        tablet: resolve(__dirname, 'tablet.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/firebase/app-check') || id.includes('node_modules/@firebase/app-check')) {
            return 'firebase-app-check';
          }
          if (id.includes('node_modules/firebase/messaging') || id.includes('node_modules/@firebase/messaging')) {
            return 'firebase-messaging';
          }
          if (id.includes('node_modules/firebase/auth') || id.includes('node_modules/@firebase/auth')) {
            return 'firebase-auth';
          }
          if (id.includes('node_modules/firebase/firestore') || id.includes('node_modules/@firebase/firestore')) {
            return 'firebase-firestore';
          }
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) {
            return 'firebase-core';
          }
          if (id.includes('/src/logger.js') || id.includes('/src/utils.js') || id.includes('/src/i18n.js') || id.includes('/src/state.js')) {
            return 'shared';
          }
        }
      }
    }
  }
});
