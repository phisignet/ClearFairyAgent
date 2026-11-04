// 開発用: 開発ホストの拡張機能に依頼を出し、結果を待って表示する（src/dev/jobs.ts）。
// 使い方: node scripts/dev-job.mjs <依頼の JSON か、それを書いたファイルのパス> [--workspace spike/playground] [--timeout 300]
//   例: node scripts/dev-job.mjs '{"type":"ping"}'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: { workspace: { type: 'string', default: 'spike/playground' }, timeout: { type: 'string', default: '300' } },
});
const arg = positionals[0];
if (!arg) throw new Error('依頼の JSON を渡してください');
const job = existsSync(arg) ? readFileSync(arg, 'utf8') : arg;
JSON.parse(job); // 形式の確認

const dir = join(opt.workspace, '.clearfairy', 'dev', 'jobs');
mkdirSync(dir, { recursive: true });
const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
// 書きかけのファイルを拾われないよう、書き終えてから名前を変える
writeFileSync(join(dir, `${id}.tmp`), job);
renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.job.json`));

const resultFile = join(dir, `${id}.result.json`);
const deadline = Date.now() + Number(opt.timeout) * 1000;
while (!existsSync(resultFile)) {
  if (Date.now() > deadline) {
    rmSync(join(dir, `${id}.job.json`), { force: true });
    console.error('時間内に結果が返らなかった（開発ホストが開いているか確認してください）');
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 300));
}
// 書き込みの途中を読まないよう、少し待ってから読む
await new Promise((r) => setTimeout(r, 100));
const result = readFileSync(resultFile, 'utf8');
rmSync(resultFile, { force: true });
console.log(result);
if (!JSON.parse(result).ok) process.exit(1);
