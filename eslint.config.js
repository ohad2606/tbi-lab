// Lint applies to production code only. experiments/ is frozen Sprint 0/1 evidence.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'experiments/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  {
    files: [
      'app/**/*.{ts,tsx}',
      'packages/**/*.ts',
      'runtime/**/*.{ts,mjs}',
      '*.config.ts',
      'scripts/**/*.mjs',
      'eslint.config.js',
    ],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/experiments/**', 'experiments/**'],
              message: 'Production code must not import from experiments/ (roadmap §5.1).',
            },
          ],
        },
      ],
    },
  },
  {
    // Tests may use `any` to build deliberately malformed documents.
    files: ['**/tests/**/*.ts', '**/e2e/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
