// Shared ESLint config for the client packages (desktop, web, shared UI/app/contracts).
// The API uses Next.js's own config (apps/api/eslint.config.mjs).
import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export function clientConfig({ ignores = [] } = {}) {
  return tseslint.config(
    { ignores: ['dist/**', 'src-tauri/**', ...ignores] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      files: ['**/*.{ts,tsx}'],
      languageOptions: { globals: { ...globals.browser } },
      plugins: { 'react-hooks': reactHooks },
      rules: {
        ...reactHooks.configs.recommended.rules,
        // Client code never reads server configuration.
        'no-restricted-properties': ['error', { object: 'process', property: 'env', message: 'Client code reads public config from import.meta.env (VITE_*) only.' }],
      },
    },
    {
      files: ['*.config.{ts,mjs,js}', 'scripts/**'],
      languageOptions: { globals: { ...globals.node } },
      rules: { 'no-restricted-properties': 'off' },
    },
  );
}
