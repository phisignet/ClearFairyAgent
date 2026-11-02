// 開発用: F5 で開いた開発ホストでだけ、ワークスペースの .clearfairy/dev/jobs/ に置かれた依頼（<id>.job.json）を
// 処理し、結果を <id>.result.json に書く。Copilot の言語モデルはサインイン済みの VS Code の中でしか呼べないので、
// プロンプトの調整や、録ったセッションの処理し直しを、外（シェル）から頼めるようにするためのもの。ネットワークは開かない。
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';

export type JobHandler = (job: Record<string, unknown>) => Promise<unknown>;

export function startDevJobs(context: vscode.ExtensionContext, log: vscode.OutputChannel, handlers: Record<string, JobHandler>): vscode.Disposable | undefined {
  if (context.extensionMode !== vscode.ExtensionMode.Development) return undefined;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return undefined;
  const dir = join(folder.uri.fsPath, '.clearfairy', 'dev', 'jobs');
  mkdirSync(dir, { recursive: true });

  const run = async (file: string) => {
    // 名前を変えてから処理する（同じ依頼を二重に処理しないため）
    const running = file.replace(/\.job\.json$/, '.running.json');
    try {
      renameSync(file, running);
    } catch {
      return;
    }
    const started = Date.now();
    let result: { ok: boolean; ms?: number; result?: unknown; error?: string };
    try {
      const job = JSON.parse(readFileSync(running, 'utf8')) as Record<string, unknown>;
      const handler = handlers[String(job.type)];
      if (!handler) throw new Error(`知らない依頼: ${job.type}（${Object.keys(handlers).join(', ')}）`);
      log.appendLine(`[dev] ${job.type} を処理します`);
      result = { ok: true, result: await handler(job) };
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) };
    }
    result.ms = Date.now() - started;
    writeFileSync(file.replace(/\.job\.json$/, '.result.json'), JSON.stringify(result, null, 2));
    rmSync(running, { force: true });
  };

  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), '*.job.json'));
  watcher.onDidCreate((uri) => void run(uri.fsPath));
  // 読み込み直している間に置かれた依頼も拾う
  for (const f of readdirSync(dir)) if (f.endsWith('.job.json')) void run(join(dir, f));
  log.appendLine(`[dev] 開発用の依頼を受け付けます: ${dir}`);
  return watcher;
}
