import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: './test/workspace',
  launchArgs: ['--disable-extensions'],
  mocha: { ui: 'bdd', timeout: 180_000 },
});
