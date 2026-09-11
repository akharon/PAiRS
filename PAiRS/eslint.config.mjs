// Flat config (ESLint 9+). Replaces .eslintrc.json, which the installed ESLint
// no longer reads — the R10 guard below was silently not running.
import tseslint from 'typescript-eslint';

/**
 * R10: the core must stay editor-agnostic so it can run headless (CLI, MCP
 * server, CI) with no VS Code present. Only adapters/vscode may import `vscode`.
 */
const noVscodeImport = [
  'error',
  {
    paths: [
      {
        name: 'vscode',
        message: 'core/ and store/ must stay editor-agnostic (R10) — only adapters/vscode may import vscode.',
      },
    ],
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'vendor/**', 'node_modules/**'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: { 'no-restricted-imports': noVscodeImport },
  },
  {
    files: ['src/adapters/vscode/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  }
);
