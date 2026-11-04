// 記録を止めた後に、セッション全体から意思決定ステップを作り直す（一括処理）。処理の中身は engine.ts。
import { persistentDiagnostics } from './actionGroups';
import { Pipeline, type PipelineOptions } from './engine';
import { readActions, readUtterances } from './records';
import { toSentences, type Sentence } from './sentences';
import type { Step, Task } from './steps';
import { splitWindows } from './windows';

export interface PipelineResult {
  steps: Step[];
  tasks: Task[];
  sentences: Sentence[];
  ms: number;
}

export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const started = Date.now();
  const p = new Pipeline(o);
  const sentences = toSentences(readUtterances(o.dir));
  p.sentences.push(...sentences);
  const actions = persistentDiagnostics(readActions(o.dir));
  const windows = splitWindows(
    sentences.filter((s) => !s.noise),
    actions,
  );
  o.log?.(`文 ${sentences.length}（除外 ${sentences.filter((s) => s.noise).length}）/ 操作 ${actions.length} / 窓 ${windows.length}`);
  // 話してから書くこともあるので、補正の手がかりには次の窓の操作も入れる
  for (const [i, win] of windows.entries()) await p.addWindow(win, [...win.actions, ...(windows[i + 1]?.actions ?? [])]);
  o.log?.(`ステップ ${p.steps.length} を要約・評価します`);
  await p.analyze(p.steps);
  await p.groupTasks();
  p.save();
  return { steps: p.steps, tasks: p.tasks, sentences: p.sentences, ms: Date.now() - started };
}
