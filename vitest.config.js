import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/**/*.test.js'],
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.js', 'src/worker/**/*.js'],
      exclude: [
        'src/firebase-init.js',
        'src/admin-main.js',
        'src/main.js',
        'src/tablet-main.js',
        'src/ui-renderers.js',
      ],
    },
  },
});
