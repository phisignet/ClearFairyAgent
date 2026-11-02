// 拡張機能本体と音声ワーカー（子プロセス）を dist/ に束ねる。
// ネイティブモジュールは束ねられないので external にして node_modules から読み込ませる。
// --test を付けると統合テスト（test/*.test.ts）を out/test/ に、--unit を付けると単体テスト（test/unit/*.test.ts）を out/unit/ に束ねる。
import { readdirSync } from 'node:fs';
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: true,
  external: ['vscode', 'mocha', 'sherpa-onnx-node', '@picovoice/pvrecorder-node', 'decibri', 'audify'],
  logLevel: 'info',
};

const builds = [{ ...common, entryPoints: { extension: 'src/extension.ts', speechWorker: 'src/speech/worker.ts' }, outdir: 'dist' }];
if (process.argv.includes('--test')) {
  const tests = readdirSync('test').filter((f) => f.endsWith('.test.ts'));
  builds.push({ ...common, entryPoints: tests.map((f) => `test/${f}`), outdir: 'out/test' });
}

if (process.argv.includes('--unit')) {
  const tests = readdirSync('test/unit').filter((f) => f.endsWith('.test.ts'));
  builds.push({ ...common, entryPoints: tests.map((f) => `test/unit/${f}`), outdir: 'out/unit' });
}

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch();
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
