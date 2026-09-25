import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

export default [
  {
    ignores: ['cloud-provisioner/**', '._output/**', '_output/**', '._archive/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    plugins: {
      '@stylistic': stylistic,
    },
    rules: {
      '@stylistic/indent': ['error', 2, { SwitchCase: 1 }],
      '@stylistic/linebreak-style': ['error', 'unix'],
      '@stylistic/quotes': ['error', 'single'],
      '@stylistic/semi': ['error', 'always'],
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'preserve-caught-error': 'off',
    },
  },
  prettierConfig,
];
