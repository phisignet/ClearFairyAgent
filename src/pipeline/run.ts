// 記録したセッションから意思決定ステップを作る（論文の CLEAR と Decision Step Summary）。
//   0. 発話を文に分け、幻聴・相づちを除く                         sentences.ts
//   1. 同じ時間帯のコードを手がかりに、文字起こしを補正する          prompts/correct.md
//   2. 関連する連続した文をまとめる（Sentence Linking）             prompts/group-sentences.md
//   3. 同じ要素への同じ種類の連続した操作をまとめる（Action Linking）actionGroups.ts
//   4. 発話のまとまりと操作のまとまりを結び付ける                  prompts/link.md
//   5. 結び付かなかった発話を前後に割り当てる（Sentence Assigning） prompts/assign.md
//   6. ステップを組み立て、要約する。業務・データ固有か一般的なコーディングかも判定する  steps.ts / prompts/summarize.md
//   7. ステップの列を小作業のまとまりに分ける（上の層）              prompts/tasks.md
// 長いセッションは窓に分けて順に処理する。LLM との入出力は <セッション>/pipeline/ に残す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Action } from '../capture/actions';
import type { Message, Part, TextResult } from '../llm/llm';
import { clock, describeGroup, groupActions, imagesOf, isWeak, persistentDiagnostics, type ActionGroup } from './actionGroups';
import type { Prompts } from './prompts';
import { toSentences, type Sentence, type Utterance } from './sentences';
import { buildSteps, makeGroups, makeTasks, mergeSteps, type Direction, type SentenceGroup, type Step, type StepSummary, type Task } from './steps';
import { splitWindows, type Window } from './windows';

export interface PipelineLlm {
  json<T>(messages: Message[]): Promise<{ value: T; raw: TextResult }>;
}

export interface PipelineOptions {
  dir: string;
  prompts: Prompts;
  llm: PipelineLlm;
  log?: (message: string) => void;
  concurrency?: number;
}

export interface PipelineResult {
  steps: Step[];
  tasks: Task[];
  sentences: Sentence[];
  ms: number;
}

const MAX_LINK_IMAGES = 4;
const MAX_SUMMARY_IMAGES = 2;

// 発話や操作が 1 件も無いセッションでは、ファイル自体が無い
const readJsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// 同じ時間帯に本人が書いたコード・実行したコマンド（文字起こしの補正の手がかり）
function codeHints(actions: Action[]): string {
  const lines = new Set<string>();
  for (const a of actions) {
    if (a.kind === 'edit') for (const l of a.diff.split('\n')) if (/^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)) lines.add(l.slice(1).trim());
    if (a.kind === 'cell-run') for (const l of a.source.split('\n')) lines.add(l.trim());
    if (a.kind === 'terminal') lines.add(a.command);
    if (a.kind === 'edit' || a.kind === 'view') for (const s of a.symbols) lines.add(s);
  }
  const list = [...lines].filter((l) => l.length > 1);
  return list.slice(0, 100).join('\n') || '（なし）';
}

export async function runPipeline(o: PipelineOptions): Promise<PipelineResult> {
  const started = Date.now();
  const log = o.log ?? (() => {});
  const info = JSON.parse(readFileSync(join(o.dir, 'session.json'), 'utf8')) as { startedAt: number };
  const origin = info.startedAt;
  const at = (t: number) => clock(t, origin);
  const line = (s: Sentence) => `${s.id}: [${at(s.t0)}] ${s.text}`;
  const outDir = join(o.dir, 'pipeline');
  mkdirSync(outDir, { recursive: true });
  const image = (path: string): Part[] => [`画像 ${path}:`, { image: readFileSync(join(o.dir, path)), mime: path.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }];

  // LLM を呼び、入出力を pipeline/ に残す
  const ask = async <T>(name: string, prompt: string, images: string[] = []): Promise<T> => {
    const content: Part[] = [prompt, ...images.flatMap(image)];
    const r = await o.llm.json<T>([{ role: 'user', content }]);
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ model: r.raw.model, ms: r.raw.ms, images, prompt, response: r.raw.text, value: r.value }, null, 2));
    log(`  ${name}: ${r.raw.ms}ms`);
    return r.value;
  };

  // 0. 文に分け、幻聴・相づちを除く
  const sentences = toSentences(readJsonl<Utterance>(join(o.dir, 'utterances.jsonl')));
  const actions = persistentDiagnostics(readJsonl<Action>(join(o.dir, 'actions.jsonl')));
  const windows = splitWindows(
    sentences.filter((s) => !s.noise),
    actions,
  );
  log(`文 ${sentences.length}（除外 ${sentences.filter((s) => s.noise).length}）/ 操作 ${actions.length} / 窓 ${windows.length}`);

  const steps: Step[] = [];
  let groupCount = 0;
  let actionGroupCount = 0;
  for (const [w, win] of windows.entries()) {
    const tag = `w${String(w + 1).padStart(2, '0')}`;
    log(`窓 ${w + 1}/${windows.length}（${at(win.t0)}〜${at(win.t1)}）`);
    const kept = await correct(win, windows[w + 1], tag);
    if (kept.length === 0 && win.actions.length === 0) continue;

    // 2. 文のまとめ
    let groups: SentenceGroup[] = [];
    if (kept.length > 0) {
      const r = await ask<{ groups: string[][] }>(`${tag}-2-group`, o.prompts.render('group-sentences', { sentences: kept.map(line).join('\n') }));
      groups = makeGroups(r.groups ?? [], kept, groupCount);
      groupCount += groups.length;
    }

    // 3. 操作のまとめ
    const actionGroups = groupActions(win.actions, actionGroupCount);
    actionGroupCount += actionGroups.length;

    // 4. 結び付け
    const links: Record<string, string[]> = {};
    if (groups.length > 0 && actionGroups.length > 0) {
      const images = actionGroups.flatMap(imagesOf).slice(-MAX_LINK_IMAGES);
      const r = await ask<{ links: { group: string; actions: string[] }[] }>(
        `${tag}-4-link`,
        o.prompts.render('link', {
          groups: groups.map((g) => `${g.id}:\n${g.sentences.map((s) => `  [${at(s.t0)}] ${s.text}`).join('\n')}`).join('\n'),
          actions: actionGroups.map((g) => describeGroup(g, origin)).join('\n'),
        }),
        images,
      );
      const validActions = new Set(actionGroups.map((g) => g.id));
      for (const l of r.links ?? []) links[l.group] = (l.actions ?? []).filter((a) => validActions.has(a));
    }

    // 5. 操作と結び付かなかった発話（閲覧・エラー表示とだけ結び付いたものを含む）の割り当て。
    //    窓の先頭のまとまりは、前の窓の最後のステップを left として見せる（窓の境目で判断が割れないように）
    const assignments: Record<string, Direction> = {};
    const byGroup = new Map(actionGroups.map((g) => [g.id, g]));
    const hasStrongLink = (id: string) => (links[id] ?? []).some((a) => !isWeak(byGroup.get(a) ?? { kind: 'view' }));
    const previous = steps[steps.length - 1];
    const unlinked = groups.map((g, i) => ({ g, i })).filter(({ g }) => !hasStrongLink(g.id));
    if (unlinked.length > 0) {
      const text = (g?: SentenceGroup) => (g ? g.sentences.map((s) => s.text).join(' ') : '（なし）');
      const left = (i: number) =>
        i > 0 ? `（${groups[i - 1].id}）: ${text(groups[i - 1])}` : previous ? `（前の区切りの最後のステップ）: ${previous.sentences.map((s) => s.text).join(' ') || '（操作だけ）'}` : ': （なし）';
      const targets = unlinked.map(({ g, i }) => `- 対象 ${g.id}: ${text(g)}\n  left${left(i)}\n  right${groups[i + 1] ? `（${groups[i + 1].id}）` : ''}: ${text(groups[i + 1])}`);
      const r = await ask<{ assignments: { group: string; direction: Direction }[] }>(
        `${tag}-5-assign`,
        o.prompts.render('assign', { transcript: [...(previous?.sentences ?? []), ...kept].map(line).join('\n'), targets: targets.join('\n') }),
      );
      for (const a of r.assignments ?? []) if (['left', 'right', 'unrelated'].includes(a.direction)) assignments[a.group] = a.direction;
    }

    const built = buildSteps(groups, actionGroups, links, assignments);
    // 窓の先頭のまとまりが left に割り当てられたら、そのステップを前の窓の最後のステップに合流させる
    if (previous && groups[0] && assignments[groups[0].id] === 'left') {
      const first = built.find((s) => s.sentences.includes(groups[0].sentences[0]));
      if (first) {
        mergeSteps(previous, first);
        built.splice(built.indexOf(first), 1);
      }
    }
    steps.push(...built);
  }
  steps.sort((a, b) => a.t0 - b.t0).forEach((s, i) => (s.id = `st${i + 1}`));

  // 6. 要約
  const clean = sentences.filter((s) => !s.noise);
  log(`ステップ ${steps.length} を要約します`);
  await mapLimit(steps, o.concurrency ?? 3, async (step) => {
    const context = clean.filter((s) => s.t0 >= step.t0 - 180_000 && s.t0 <= step.t1 + 120_000);
    step.summary = await ask<StepSummary>(
      `summary-${step.id}`,
      o.prompts.render('summarize', {
        transcript: context.map((s) => `[${at(s.t0)}] ${s.text}`).join('\n') || '（なし）',
        step_sentences: step.sentences.map((s) => `[${at(s.t0)}] ${s.text}`).join('\n') || '（発話なし）',
        step_actions: step.actionGroups.map((g) => describeGroup(g, origin)).join('\n') || '（操作なし）',
      }),
      step.actionGroups.flatMap(imagesOf).slice(-MAX_SUMMARY_IMAGES),
    );
    // 判定が無いときは、見落とさないよう業務・データ固有として扱う
    if (step.summary.knowledge !== 'general') step.summary.knowledge = 'domain';
  });

  // 7. 小作業のまとまり
  let tasks: Task[] = [];
  if (steps.length > 0) {
    const knowledgeLabel = (s: Step) => (s.summary?.knowledge === 'general' ? '一般的なコーディング' : '業務・データ固有');
    const r = await ask<{ tasks: { title?: string; summary?: string; steps?: string[] }[] }>(
      '7-tasks',
      o.prompts.render('tasks', {
        steps: steps.map((s) => `${s.id} [${at(s.t0)}]（${knowledgeLabel(s)}）\n  判断: ${s.summary?.decision_and_actions}\n  理由: ${s.summary?.rationale}`).join('\n'),
      }),
    );
    tasks = makeTasks(r.tasks ?? [], steps);
  }

  writeFileSync(join(o.dir, 'sentences.json'), JSON.stringify(sentences, null, 2));
  writeFileSync(
    join(o.dir, 'steps.json'),
    JSON.stringify(
      {
        version: 2,
        generatedAt: Date.now(),
        tasks,
        steps: steps.map((s) => ({
          id: s.id,
          t0: s.t0,
          t1: s.t1,
          kind: s.kind,
          summary: s.summary,
          sentences: s.sentences.map(({ id, t0, text, original }) => ({ id, t0, text, original })),
          actionGroups: s.actionGroups.map((g: ActionGroup) => ({ id: g.id, kind: g.kind, element: g.element, actions: g.actions.map((a) => a.id) })),
        })),
      },
      null,
      2,
    ),
  );
  return { steps, tasks, sentences, ms: Date.now() - started };

  // 1. 文字起こしの補正。手がかりには、話してから書くこともあるので次の窓のコードも入れる
  async function correct(win: Window, next: Window | undefined, tag: string): Promise<Sentence[]> {
    if (win.sentences.length === 0) return [];
    const r = await ask<{ sentences: { id: string; text: string | null }[] }>(
      `${tag}-1-correct`,
      o.prompts.render('correct', { code: codeHints([...win.actions, ...(next?.actions ?? [])]), sentences: win.sentences.map(line).join('\n') }),
    );
    const fixed = new Map((r.sentences ?? []).map((s) => [s.id, s.text]));
    for (const s of win.sentences) {
      if (!fixed.has(s.id)) continue;
      const text = fixed.get(s.id);
      if (text === null || text === undefined || text.trim() === '') s.noise = 'hallucination';
      else if (text !== s.text) {
        s.original = s.text;
        s.text = text;
      }
    }
    return win.sentences.filter((s) => !s.noise);
  }
}
