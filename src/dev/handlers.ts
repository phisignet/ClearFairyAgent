// 開発用の依頼の中身（scripts/dev-job.mjs から頼む。受け口は jobs.ts）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { copilotModels, Llm, type Message, type Part } from '../llm/llm';
import { Pipeline, type PipelineLlm, type PipelineOptions } from '../pipeline/engine';
import { loadHistory } from '../pipeline/history';
import { LivePipeline } from '../pipeline/live';
import { readActions, readSessionInfo, readUtterances } from '../pipeline/records';
import { runPipeline } from '../pipeline/run';
import { openQuestionCount } from '../pipeline/steps';
import { sessionsRoot } from '../session/session';
import type { QuestionsController } from '../ui/questions';
import type { SessionController } from '../ui/sessionControls';
import type { SessionViews } from '../ui/sessionView';
import type { JobHandler } from './jobs';

export interface DevDeps {
  context: vscode.ExtensionContext;
  controller: SessionController;
  questions: QuestionsController;
  views: SessionViews;
  llm: Llm;
  pipelineOptions(dir: string, target?: PipelineLlm): PipelineOptions;
}

export function devHandlers({ context, controller, questions, views, llm, pipelineOptions }: DevDeps): Record<string, JobHandler> {
  const sessionDir = (job: Record<string, unknown>) => join(sessionsRoot(context), String(job.session));
  const devDir = (name: string) => join(sessionsRoot(context), '..', 'dev', name);
  const llmOf = (job: Record<string, unknown>) => (typeof job.model === 'string' ? new Llm(() => job.model as string) : llm);

  return {
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
      const target = llmOf(job);
      return job.json ? target.json(messages) : target.text(messages);
    },
    // 記録したセッションから意思決定ステップを作る（{ "session": "<id>", "model"?: "<id か family>" }）。
    // "copy": true なら .clearfairy/dev/rerun-<id>/ に写して作り直す（元の結果と回答は変えず、質問の一覧にも出さない）
    pipeline: async (job) => {
      const src = sessionDir(job);
      let dir = src;
      if (job.copy) {
        dir = devDir(`rerun-${job.session}`);
        rmSync(dir, { recursive: true, force: true });
        cpSync(src, dir, { recursive: true, filter: (f) => !/[\\/](steps\.json|sentences\.json|pipeline)$/.test(f) });
      }
      const r = await runPipeline({ ...pipelineOptions(dir, llmOf(job)), history: () => loadHistory(sessionsRoot(context), src) });
      if (!job.copy) questions.refresh();
      return {
        ms: r.ms,
        steps: r.steps.length,
        kinds: r.steps.reduce<Record<string, number>>((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {}),
        noise: r.sentences.filter((s) => s.noise).length,
        corrected: r.sentences.filter((s) => s.original).length,
        questions: openQuestionCount(r.steps),
        domain: r.steps
          .filter((s) => s.summary?.knowledge === 'domain')
          .map((s) => ({ step: s.id, type: s.summary?.step_type, level: s.evaluation?.level, decision: s.summary?.decision_and_actions, kind: s.question?.kind, question: s.question?.text, inferred: s.inference?.text, skip: s.questionSkipped })),
      };
    },
    // 質問だけ作り直す（{ "session": "<id>" }）。未回答の質問と、質問しなかった判断を考え直す
    // "all": true なら答えた質問も作り直す。"dry": true なら保存しない（前の記録の説明で聞き直しが減るかを見るときなど）
    questions: async (job) => {
      const p = Pipeline.load(pipelineOptions(sessionDir(job)));
      for (const s of p.steps) {
        if (s.question?.status === 'open' || (job.all && s.question)) {
          s.question = undefined;
          s.inference = undefined;
        }
        s.questionSkipped = undefined;
      }
      await p.askQuestions(p.steps);
      if (!job.dry) {
        p.save();
        questions.refresh();
      }
      return p.steps
        .filter((s) => s.summary?.knowledge === 'domain' && s.evaluation?.level !== 'strong')
        .map((s) => ({
          step: s.id,
          level: s.evaluation?.level,
          decision: s.summary?.decision_and_actions,
          kind: s.question?.kind,
          question: s.question?.text,
          inferred: s.inference?.text,
          basis: s.inference?.basis.map((b) => `${b.session ?? 'この記録'} ${b.step}: ${b.rationale}`),
          skip: s.questionSkipped,
        }));
    },
    // 質問を出した判断の理由を、過去の判断から推測する（{ "session": "<id>", "step"?: "<ステップ id>" }）。結果は保存しない。
    // 実際の回答と並べて返す（推測の当たり外れを見るため。推測には回答を渡さない）
    infer: async (job) => {
      const dir = sessionDir(job);
      const p = Pipeline.load(pipelineOptions(dir));
      const results = [];
      for (const s of p.steps.filter((x) => x.question && (!job.step || x.id === job.step))) {
        const { question, inference } = s;
        s.inference = undefined;
        const file = join(dir, 'pipeline', `infer-${s.id}.json`);
        rmSync(file, { force: true });
        const got = (await p.infer([s]))[0]?.inference;
        const raw = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { value: { reasoning?: string } }).value : undefined;
        results.push({
          step: s.id,
          question: question!.text,
          answer: question!.answer?.text,
          inferred: got?.text ?? null,
          reasoning: got?.reasoning ?? raw?.reasoning ?? '（推測の元にできる過去の判断が無い）',
          basis: got?.basis.map((b) => `${b.session ?? 'この記録'} ${b.step}: ${b.rationale}`),
        });
        s.inference = inference;
      }
      return results;
    },
    // 質問に答える（{ "session": "<id>", "step": "<ステップ id>", "text": "<回答>" }）
    answer: async (job) => {
      const p = Pipeline.load(pipelineOptions(sessionDir(job)));
      const step = await p.answer(String(job.step), String(job.text), 'text');
      questions.refresh();
      return step.summary;
    },
    // 記録した発話と操作を、元の間隔のまま記録中の処理に流し直す（{ "session": "<id>" }）。
    // 質問がどれだけ遅れて出るかを、実際の LLM で測る。結果は .clearfairy/dev/replay-<id>/ に置き、質問の一覧には出さない
    replay: async (job) => {
      const src = sessionDir(job);
      const dir = devDir(`replay-${job.session}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      if (existsSync(join(src, 'images'))) cpSync(join(src, 'images'), join(dir, 'images'), { recursive: true });
      const info = readSessionInfo(src);
      const shift = Date.now() + 1000 - info.startedAt;
      writeFileSync(join(dir, 'session.json'), JSON.stringify({ ...info, startedAt: info.startedAt + shift }));
      // 推測に使う過去の判断は、流し直す記録より前のものだけ（流し直しの記録は今の時刻で始まったことになるため）
      const l = new LivePipeline({ ...pipelineOptions(dir), concurrency: 6, history: () => loadHistory(sessionsRoot(context), src) });
      const events = [
        ...readUtterances(src).map((u) => ({ t: u.end + shift, add: () => l.addUtterance({ ...u, start: u.start + shift, end: u.end + shift }) })),
        ...readActions(src).map((a) => ({ t: a.t1 + shift, add: () => l.addAction({ ...a, t0: a.t0 + shift, t1: a.t1 + shift }) })),
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
      views.open(sessionDir(job));
      return 'opened';
    },
  };
}
