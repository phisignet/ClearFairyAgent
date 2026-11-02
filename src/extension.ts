import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { settings } from './config';
import { startDevJobs } from './dev/jobs';
import { copilotModels } from './llm/copilot';
import { Llm, type Message, type Part } from './llm/llm';
import { Prompts } from './pipeline/prompts';
import { runPipeline, type PipelineResult } from './pipeline/run';
import { sessionsRoot, type SessionInfo } from './session/session';
import { registerSpikeCommands } from './spike/commands';
import { SessionController } from './ui/sessionControls';
import { openSessionView } from './ui/sessionView';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('ClearFairy');
  const controller = new SessionController(context, log);
  const llm = new Llm(() => settings().llmModel);
  const prompts = new Prompts(context.asAbsolutePath('prompts'));

  const run = (dir: string, target = llm, onLog?: (m: string) => void): Promise<PipelineResult> =>
    runPipeline({
      dir,
      prompts,
      llm: target,
      log: (m) => {
        log.appendLine(`[pipeline] ${m}`);
        onLog?.(m);
      },
    });

  // 記録からステップを作り、終わったら見るかどうかを聞く
  const processSession = async (dir: string): Promise<void> => {
    try {
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ClearFairy: 記録から意思決定ステップを作っています' },
        (progress) => run(dir, llm, (m) => progress.report({ message: m })),
      );
      const answer = await vscode.window.showInformationMessage(`ClearFairy: 意思決定ステップを ${r.steps.length} 個作りました`, '記録を見る');
      if (answer) openSessionView(dir);
    } catch (e) {
      log.appendLine(`[pipeline] 失敗: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
      void vscode.window.showErrorMessage(`ClearFairy: 意思決定ステップを作れませんでした（${e instanceof Error ? e.message : e}）`);
    }
  };

  // 記録したセッションを新しい順に選ぶ
  const pickSession = async (placeHolder: string): Promise<string | undefined> => {
    const root = sessionsRoot(context);
    const items = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'session.json')))
      .map((d) => {
        const dir = join(root, d.name);
        const info = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as SessionInfo;
        const minutes = info.endedAt ? Math.round((info.endedAt - info.startedAt) / 60000) : 0;
        const processed = existsSync(join(dir, 'steps.json'));
        return {
          label: new Date(info.startedAt).toLocaleString('ja-JP'),
          description: `${minutes} 分 ・ 発話 ${info.stats?.utterances ?? 0} ・ 操作 ${info.stats?.actions ?? 0}${processed ? '' : ' ・ 未処理'}`,
          dir,
          startedAt: info.startedAt,
        };
      })
      .sort((a, b) => b.startedAt - a.startedAt);
    if (items.length === 0) {
      void vscode.window.showInformationMessage('ClearFairy: まだ記録がありません。ステータスバーの「🎤 ClearFairy」から記録を始めてください。');
      return undefined;
    }
    return (await vscode.window.showQuickPick(items, { placeHolder }))?.dir;
  };

  context.subscriptions.push(
    log,
    controller,
    vscode.commands.registerCommand('clearfairy.toggleSession', () => controller.toggle()),
    vscode.commands.registerCommand('clearfairy.startSession', () => controller.start()),
    vscode.commands.registerCommand('clearfairy.stopSession', () => controller.stop()),
    vscode.commands.registerCommand('clearfairy.openSession', async () => {
      const dir = await pickSession('見る記録を選ぶ');
      if (dir) openSessionView(dir);
    }),
    vscode.commands.registerCommand('clearfairy.processSession', async () => {
      const dir = await pickSession('意思決定ステップを作り直す記録を選ぶ');
      if (dir) await processSession(dir);
    }),
    controller.onDidStop(({ dir }) => void processSession(dir)),
  );
  registerSpikeCommands(context);

  // 開発ホストでだけ動く、外からの依頼の受け口（src/dev/jobs.ts）
  const jobs = startDevJobs(context, log, {
    ping: async () => ({
      vscode: vscode.version,
      extension: (context.extension.packageJSON as { version: string }).version,
      recording: controller.busy,
      session: controller.current?.dir,
    }),
    reload: async () => {
      if (controller.busy) throw new Error('記録中なので読み込み直さない');
      setTimeout(() => void vscode.commands.executeCommand('workbench.action.reloadWindow'), 300);
      return 'reloading';
    },
    models: async () => (await copilotModels()).map((m) => ({ id: m.id, family: m.family, name: m.name, maxInputTokens: m.maxInputTokens })),
    // messages の content には文字列か、{ "imageFile": "<パス>", "mime": "image/png" } を並べられる
    llm: async (job) => {
      type JobPart = string | { imageFile: string; mime?: string };
      const messages: Message[] = (job.messages as { role: 'user' | 'assistant'; content: string | JobPart[] }[]).map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p): Part => (typeof p === 'string' ? p : { image: readFileSync(p.imageFile), mime: p.mime ?? 'image/png' })),
      }));
      const model = typeof job.model === 'string' ? job.model : undefined;
      const target = model ? new Llm(() => model) : llm;
      return job.json ? target.json(messages) : target.text(messages);
    },
    // 記録したセッションから意思決定ステップを作る（{ "session": "<id>", "model"?: "<id か family>" }）
    pipeline: async (job) => {
      const model = typeof job.model === 'string' ? job.model : undefined;
      const r = await run(join(sessionsRoot(context), String(job.session)), model ? new Llm(() => model) : llm);
      return {
        ms: r.ms,
        steps: r.steps.length,
        kinds: r.steps.reduce<Record<string, number>>((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {}),
        noise: r.sentences.filter((s) => s.noise).length,
        corrected: r.sentences.filter((s) => s.original).length,
      };
    },
    // 記録の画面を開く（{ "session": "<id>" }）
    openSession: async (job) => {
      openSessionView(join(sessionsRoot(context), String(job.session)));
      return 'opened';
    },
  });
  if (jobs) context.subscriptions.push(jobs);
}

export function deactivate(): void {}
