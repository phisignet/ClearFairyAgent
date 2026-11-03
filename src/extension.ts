import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Action } from './capture/actions';
import { settings } from './config';
import { startDevJobs } from './dev/jobs';
import { copilotModels } from './llm/copilot';
import { Llm, type Message, type Part } from './llm/llm';
import { Pipeline, type PipelineOptions } from './pipeline/engine';
import { LivePipeline } from './pipeline/live';
import { Prompts } from './pipeline/prompts';
import { runPipeline, type PipelineResult } from './pipeline/run';
import type { Step } from './pipeline/steps';
import { sessionsRoot, type SessionInfo } from './session/session';
import { VoiceAnswer } from './speech/voiceAnswer';
import { registerSpikeCommands } from './spike/commands';
import { QuestionsController } from './ui/questions';
import { SessionController } from './ui/sessionControls';
import { openSessionView, refreshSessionView } from './ui/sessionView';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('ClearFairy');
  const controller = new SessionController(context, log);
  const llm = new Llm(() => settings().llmModel);
  const prompts = new Prompts(context.asAbsolutePath('prompts'));

  const pipelineOptions = (dir: string, target = llm, onLog?: (m: string) => void): PipelineOptions => ({
    dir,
    prompts,
    llm: target,
    log: (m) => {
      log.appendLine(`[pipeline] ${m}`);
      onLog?.(m);
    },
  });
  const run = (dir: string, target = llm, onLog?: (m: string) => void): Promise<PipelineResult> => runPipeline(pipelineOptions(dir, target, onLog));

  // 記録中のセッションの逐次処理
  let live: { dir: string; live: LivePipeline } | undefined;

  const questions = new QuestionsController({
    sessionsRoot: () => sessionsRoot(context),
    pipelineOptions: (dir) => pipelineOptions(dir),
    current: () => live,
    // 記録中は作業の録音をそのまま使い、記録していなければ回答用に短く録音する
    startVoice: async (onText, onError) => {
      const session = controller.current;
      if (session) {
        session.beginAnswer();
        const sub = session.onAnswerText(onText);
        return {
          get speaking() {
            return session.speaking;
          },
          stop: async () => {
            try {
              return await session.endAnswer();
            } finally {
              sub.dispose();
            }
          },
        };
      }
      const model = await controller.speechModel();
      if (!model) throw new Error('音声認識モデルがありません');
      return VoiceAnswer.start({ workerScript: context.asAbsolutePath(join('dist', 'speechWorker.js')), model, threads: settings().threads, log, onText, onError });
    },
    log,
  }).register();

  const openCount = (steps: Step[]) => steps.filter((s) => s.question?.status === 'open').length;

  // 終わったら、見るかどうかを聞く
  const offerView = async (dir: string, steps: Step[]) => {
    const open = openCount(steps);
    const actions = open > 0 ? ['質問に答える', '記録を見る'] : ['記録を見る'];
    const answer = await vscode.window.showInformationMessage(
      `ClearFairy: 意思決定ステップを ${steps.length} 個作りました${open > 0 ? `（確認の質問 ${open} 件）` : ''}`,
      ...actions,
    );
    if (answer === '記録を見る') openSessionView(dir);
    if (answer === '質問に答える') await vscode.commands.executeCommand('clearfairy.showQuestions');
  };

  // 記録からステップを作り直す
  const processSession = async (dir: string): Promise<void> => {
    if (live?.dir === dir) {
      void vscode.window.showWarningMessage('ClearFairy: 記録中のセッションは作り直せません。記録を止めてから実行してください。');
      return;
    }
    if (existsSync(join(dir, 'steps.json'))) {
      const { steps } = JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8')) as { steps: Step[] };
      const answered = steps.filter((s) => s.question?.status === 'answered').length;
      if (answered > 0) {
        const ok = await vscode.window.showWarningMessage(
          `この記録には回答済みの質問が ${answered} 件あります。作り直すと、回答を反映した要約と質問は作り直されます（回答の文字起こしは answers.jsonl に残ります）。`,
          { modal: true },
          '作り直す',
        );
        if (!ok) return;
      }
    }
    try {
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ClearFairy: 記録から意思決定ステップを作っています' },
        (progress) => run(dir, llm, (m) => progress.report({ message: m })),
      );
      questions.refresh();
      await offerView(dir, r.steps);
    } catch (e) {
      log.appendLine(`[pipeline] 失敗: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
      void vscode.window.showErrorMessage(`ClearFairy: 意思決定ステップを作れませんでした（${e instanceof Error ? e.message : e}）`);
    }
  };

  // 記録を始めたら、たまった発話と操作から少しずつステップを作り、質問を出す
  controller.onDidStart((session) => {
    const l = new LivePipeline({
      ...pipelineOptions(session.dir),
      // 質問を早く出すため、記録中は要約などを多めに並べて呼ぶ
      concurrency: 6,
      onChange: () => {
        questions.refresh();
        refreshSessionView(session.dir);
      },
    });
    session.onUtterance((u) => l.addUtterance(u));
    session.onAction((a) => l.addAction(a));
    live = { dir: session.dir, live: l };
    questions.refresh();
  });

  // 止めたら残りを処理して、小作業のまとまりを作る
  const finishSession = async (dir: string): Promise<void> => {
    const current = live;
    if (current?.dir !== dir) return processSession(dir);
    try {
      const p = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'ClearFairy: 残りの記録から意思決定ステップを作っています' },
        () => current.live.finish(),
      );
      if (live === current) live = undefined;
      questions.refresh();
      await offerView(dir, p.steps);
    } catch (e) {
      if (live === current) live = undefined;
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
    questions,
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
    controller.onDidStop(({ dir }) => {
      // 記録中の録音で答えていたら、聞き取った分を入力欄に残して終える
      void questions.stopVoice();
      void finishSession(dir);
    }),
  );
  registerSpikeCommands(context);

  // 開発ホストでだけ動く、外からの依頼の受け口（src/dev/jobs.ts）
  const jobs = startDevJobs(context, log, {
    ping: async () => ({
      vscode: vscode.version,
      extension: (context.extension.packageJSON as { version: string }).version,
      recording: controller.busy,
      session: controller.current?.dir,
      openQuestions: questions.openCount,
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
      questions.refresh();
      return {
        ms: r.ms,
        steps: r.steps.length,
        kinds: r.steps.reduce<Record<string, number>>((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {}),
        noise: r.sentences.filter((s) => s.noise).length,
        corrected: r.sentences.filter((s) => s.original).length,
        questions: openCount(r.steps),
      };
    },
    // 質問だけ作り直す（{ "session": "<id>" }）。未回答の質問と、質問しなかった判断を考え直す
    questions: async (job) => {
      const p = Pipeline.load(pipelineOptions(join(sessionsRoot(context), String(job.session))));
      for (const s of p.steps) {
        if (s.question?.status === 'open') s.question = undefined;
        s.questionSkipped = undefined;
      }
      await p.askQuestions(p.steps);
      p.save();
      questions.refresh();
      return p.steps
        .filter((s) => s.summary?.knowledge === 'domain' && s.evaluation?.level !== 'strong')
        .map((s) => ({ step: s.id, level: s.evaluation?.level, decision: s.summary?.decision_and_actions, question: s.question?.text, skip: s.questionSkipped }));
    },
    // 質問に答える（{ "session": "<id>", "step": "<ステップ id>", "text": "<回答>" }）
    answer: async (job) => {
      const p = Pipeline.load(pipelineOptions(join(sessionsRoot(context), String(job.session))));
      const step = await p.answer(String(job.step), String(job.text), 'text');
      questions.refresh();
      return step.summary;
    },
    // 記録した発話と操作を、元の間隔のまま記録中の処理に流し直す（{ "session": "<id>" }）。
    // 質問がどれだけ遅れて出るかを、実際の LLM で測る。結果は .clearfairy/dev/replay-<id>/ に置き、質問の一覧には出さない
    replay: async (job) => {
      const src = join(sessionsRoot(context), String(job.session));
      const dir = join(sessionsRoot(context), '..', 'dev', `replay-${job.session}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      if (existsSync(join(src, 'images'))) cpSync(join(src, 'images'), join(dir, 'images'), { recursive: true });
      const info = JSON.parse(readFileSync(join(src, 'session.json'), 'utf8')) as SessionInfo;
      const shift = Date.now() + 1000 - info.startedAt;
      writeFileSync(join(dir, 'session.json'), JSON.stringify({ ...info, startedAt: info.startedAt + shift }));
      const lines = (f: string) => (existsSync(join(src, f)) ? readFileSync(join(src, f), 'utf8').split('\n').filter(Boolean) : []);
      const l = new LivePipeline({ ...pipelineOptions(dir), concurrency: 6 });
      const events = [
        ...lines('utterances.jsonl').map((x) => {
          const u = JSON.parse(x) as { start: number; end: number; text: string };
          return { t: u.end + shift, add: () => l.addUtterance({ ...u, start: u.start + shift, end: u.end + shift }) };
        }),
        ...lines('actions.jsonl').map((x) => {
          const a = JSON.parse(x) as Action;
          return { t: a.t1 + shift, add: () => l.addAction({ ...a, t0: a.t0 + shift, t1: a.t1 + shift }) };
        }),
      ];
      await Promise.all(events.map((e) => new Promise<void>((r) => setTimeout(() => (e.add(), r()), Math.max(0, e.t - Date.now())))));
      await new Promise((r) => setTimeout(r, Math.max(0, (info.endedAt ?? 0) + shift - Date.now())));
      const p = await l.finish();
      const at = (t: number) => Math.round((t - info.startedAt - shift) / 1000);
      return p.steps
        .filter((s) => s.question)
        .map((s) => ({ step: s.id, from: at(s.t0), to: at(s.t1), asked: at(s.question!.createdAt), delay: at(s.question!.createdAt) - at(s.t1), question: s.question!.text }));
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
