const js = require('@eslint/js');

// Minimalna konfiguracja ESLint dla backendu (Node.js, CommonJS). Celem jest
// catching real mistakes (unused variables, undeclared globals, a missing await and so
// on) rather than enforcing style - which is why we start from "recommended" without
// additional, restrictive stylistic rules (style
// formatowania dba Prettier, patrz .prettierrc).
module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        __dirname: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly'
      }
    },
    rules: {
      // Error parameters in catch blocks (e.g. `catch (e) {}` used to swallow ALTER
      // TABLE errors during the migrations in db.js) should not be a lint error.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_|^e$|^err$', caughtErrorsIgnorePattern: '^_|^e$|^err$' }],
      'no-empty': ['warn', { allowEmptyCatch: true }]
    }
  },
  {
    ignores: ['node_modules/**', 'backups/**', '*.db', 'public/**']
  }
];
