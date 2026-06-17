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
    ignores: ['dist/**', 'node_modules/**', 'functions/**', '_fb/**'],
  },
];
