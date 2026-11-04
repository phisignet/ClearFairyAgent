import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { settings } from './config';
import { devHandlers } from './dev/handlers';
import { startDevJobs } from './dev/jobs';
import { errorDetail, errorMessage } from './format';
import { Llm } from './llm/llm';
import type { PipelineLlm, PipelineOptions } from './pipeline/engine';
import { loadHistory } from './pipeline/history';
import { LivePipeline } from './pipeline/live';
import { Prompts } from './pipeline/prompts';
import { readSessionInfo, readSteps } from './pipeline/records';
import { runPipeline } from './pipeline/run';
import { openQuestionCount, type Step } from './pipeline/steps';
import { sessionsRoot } from './session/session';
import { QuestionsController } from './ui/questions';
import { SessionController } from './ui/sessionControls';
import { SessionViews } from './ui/sessionView';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('ClearFairy');
  const controller = new SessionController(context, log);
  const llm = new Llm(() => settings().llmModel);
  const prompts = new Prompts(context.asAbsolutePath('prompts'));
  const views = new SessionViews(context.extensionUri);

  const pipelineOptions = (dir: string, target: PipelineLlm = llm, onLog?: (m: string) => void): PipelineOptions => ({
    dir,
    prompts,
    llm: target,
    log: (m) => {
      log.appendLine(`[pipeline] ${m}`);
      onLog?.(m);
    },
    // 理由の推測には、同じワークスペースの前の記録の判断も使う
    history: () => loadHistory(sessionsRoot(context), dir),
  });

  // 記録中と、止めた後の処理が終わっていないセッションの逐次処理
  const lives = new Map<string, LivePipeline>();

  const questions = new QuestionsController({
    extensionUri: context.extensionUri,
    sessionsRoot: () => sessionsRoot(context),
    pipelineOptions: (dir) => pipelineOptions(dir),
    lives: () => lives,
    startVoice: (onText, onError) => controller.startVoice(onText, onError),
    onAnswered: (dir) => views.refresh(dir),
    log,
  }).register();

  const reportFailure = (e: unknown) => {
    log.appendLine(`[pipeline] 失敗: ${errorDetail(e)}`);
    void vscode.window.showErrorMessage(`ClearFairy: 意思決定ステップを作れませんでした（${errorMessage(e)}）`);
  };

  // 終わったら、見るかどうかを聞く。partial: 処理しきれなかった分が残っている
  const offerView = async (dir: string, steps: Step[], partial = false) => {
    const open = openQuestionCount(steps);
    const actions = open > 0 ? ['質問に答える', '記録を見る'] : ['記録を見る'];
    const message = `ClearFairy: 意思決定ステップを ${steps.length} 個作りました${open > 0 ? `（確認の質問 ${open} 件）` : ''}${partial ? '。一部は処理しきれませんでした。「記録から意思決定ステップを作り直す」でやり直せます' : ''}`;
    const answer = await (partial ? vscode.window.showWarningMessage(message, ...actions) : vscode.window.showInformationMessage(message, ...actions));
    if (answer === '記録を見る') views.open(dir);
    if (answer === '質問に答える') await vscode.commands.executeCommand('clearfairy.showQuestions');
  };

  // 記録からステップを作り直す
  const processSession = async (dir: string): Promise<void> => {
    if (lives.has(dir)) {
      void vscode.window.showWarningMessage('ClearFairy: 記録中のセッションは作り直せません。記録を止めて、処理が終わってから実行してください。');
      return;
    }
    const answered = readSteps(dir)?.steps.filter((s) => s.question?.status === 'answered').length ?? 0;
    if (answered > 0) {
      const ok = await vscode.window.showWarningMessage(`この記録には回答済みの質問が ${answered} 件あります。作り直すと、回答と、回答を反映した理由は消えます。`, { modal: true }, '作り直す');
      if (!ok) return;
    }
    try {
      const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ClearFairy: 記録から意思決定ステップを作っています' }, (progress) =>
        runPipeline(pipelineOptions(dir, llm, (m) => progress.report({ message: m }))),
      );
      questions.refresh();
      await offerView(dir, r.steps);
    } catch (e) {
      reportFailure(e);
    }
  };

  // 記録を始めたら、たまった発話と操作から少しずつステップを作り、質問を出す
  controller.onDidStart((session) => {
    let warned = false;
    const l = new LivePipeline({
      ...pipelineOptions(session.dir),
      // 質問を早く出すため、記録中は要約などを多めに並べて呼ぶ
      concurrency: 6,
      onChange: () => {
        questions.refresh();
        views.refresh(session.dir);
      },
      // 作業の邪魔にならないよう、記録の中で 1 回だけ知らせる
      onFailure: (message) => {
        if (warned) return;
        warned = true;
        void vscode.window.showWarningMessage(`ClearFairy: 言語モデルの呼び出しに失敗しました。少し後でやり直します（${message}）`);
      },
    });
    session.onUtterance((u) => l.addUtterance(u));
    session.onAction((a) => l.addAction(a));
    lives.set(session.dir, l);
    questions.refresh();
  });

  // 止めたら残りを処理して、小作業のまとまりを作る
  const finishSession = async (dir: string): Promise<void> => {
    const live = lives.get(dir);
    if (!live) return processSession(dir);
    let steps: Step[] | undefined;
    try {
      steps = (await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'ClearFairy: 残りの記録から意思決定ステップを作っています' }, () => live.finish())).steps;
    } catch (e) {
      reportFailure(e);
    }
    const partial = live.unprocessed > 0;
    lives.delete(dir);
    questions.refresh();
    if (steps) await offerView(dir, steps, partial);
  };

  // 記録したセッションを新しい順に選ぶ
  const pickSession = async (placeHolder: string): Promise<string | undefined> => {
    const root = sessionsRoot(context);
    const names = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'session.json'))) : [];
    const items = names
      .map((d) => {
        const dir = join(root, d.name);
        const info = readSessionInfo(dir);
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
    questions,
    vscode.commands.registerCommand('clearfairy.toggleSession', () => controller.toggle()),
    vscode.commands.registerCommand('clearfairy.startSession', () => controller.start()),
    vscode.commands.registerCommand('clearfairy.stopSession', () => controller.stop()),
    vscode.commands.registerCommand('clearfairy.openSession', async () => {
      const dir = await pickSession('見る記録を選ぶ');
      if (dir) views.open(dir);
    }),
    vscode.commands.registerCommand('clearfairy.processSession', async () => {
      const dir = await pickSession('意思決定ステップを作り直す記録を選ぶ');
      if (dir) await processSession(dir);
    }),
    controller.onDidStop(({ dir }) => {
      // 記録中の録音で答えていたら、聞き取った分を入力欄に残して終える
      void questions.stopVoice();
      void finishSession(dir);
    }),
  );

  // 開発ホストでだけ動く、外からの依頼の受け口（src/dev/）
  const jobs = startDevJobs(context, log, devHandlers({ context, controller, questions, views, llm, pipelineOptions }));
  if (jobs) context.subscriptions.push(jobs);
}

export function deactivate(): void {}
