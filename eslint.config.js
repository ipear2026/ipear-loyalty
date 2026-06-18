import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        // App globals (window.* surface that legacy code still uses)
        firebase: 'readonly',
        confetti: 'readonly',
        grecaptcha: 'readonly',
        QRCode: 'readonly',
        jsQR: 'readonly',
        switchTab: 'writable',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_|^e$',
      }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-useless-escape': 'error',
      'no-prototype-builtins': 'warn',
      'no-undef': 'error',
      'no-cond-assign': ['error', 'except-parens'],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'no-irregular-whitespace': 'off',
      // Guard against re-introducing console spam
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.serviceworker,
        firebase: 'readonly',
        importScripts: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
    },
  },
  {
    files: ['src/logger.js'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Cloudflare Worker root + extracted lib — Node/Worker globals, console allowed
    files: ['email-worker.js', 'src/worker/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.worker,
        ...globals.node,
        crypto: 'readonly',
      },
    },
    rules: {
      'no-console': 'off',
      // The worker root is a long-lived monolith with several intentionally
      // retained helpers (in-memory rate limiters kept as fallbacks for the
      // KV-backed path). Downgrade orphan-symbol checks to warnings so they
      // don't gate CI, but keep them visible.
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_|^e$',
      }],
      'no-useless-escape': 'warn',
    },
  },
  {
    files: ['tests/**/*.js', 'vitest.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'functions/**', '_fb/**', '.wrangler/**', '.firebase/**'],
  },
];
