import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

// Minimal ESLint configuration for the frontend (React + Vite). As in the
// backend eslint.config.js - the goal is catching real mistakes (hooks used outside a
// component, unused variables, missing dependencies
// in useEffect) rather than enforcing style, which is Prettier's job (see .prettierrc).
export default [
  js.configs.recommended,
  {
    // Tooling scripts (scripts/) run in Node, not the browser - they have
    // process/console/__dirname rather than window/document. Without this block ESLint
    // reported them as 32 "'console' is not defined" errors.
    files: ['scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        __dirname: 'readonly',
        URL: 'readonly'
      }
    }
  },
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        console: 'readonly',
        fetch: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        navigator: 'readonly',
        confirm: 'readonly',
        prompt: 'readonly',
        alert: 'readonly',
        FormData: 'readonly',
        FileReader: 'readonly',
        Image: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Blob: 'readonly',
        atob: 'readonly',
        btoa: 'readonly'
      }
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$|^err$', caughtErrorsIgnorePattern: '^_|^e$|^err$' }]
    }
  },
  {
    ignores: ['node_modules/**', 'dist/**']
  }
];
