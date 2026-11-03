// 意思決定ステップを作る処理の本体（論文の CLEAR、要約、理由の評価、質問）。
// 窓（区切り）を 1 つずつ足していけるので、記録中の逐次処理（live.ts）と記録後の一括処理（run.ts）の両方で使う。
//   1. 同じ時間帯のコードを手がかりに、文字起こしを補正する          prompts/correct.md
//   2. 関連する連続した文をまとめる（Sentence Linking）             prompts/group-sentences.md
//   3. 同じ要素への同じ種類の連続した操作をまとめる（Action Linking）actionGroups.ts
//   4. 発話のまとまりと操作のまとまりを結び付ける                  prompts/link.md
//   5. 結び付かなかった発話を前後に割り当てる（Sentence Assigning） prompts/assign.md
//   6. ステップを組み立てて要約し、業務・データ固有か一般的なコーディングかを判定する  steps.ts / prompts/summarize.md
//   7. 業務・データ固有のステップの理由を評価し（Rationale Evaluation）、弱い・無いものに質問を作る
//      prompts/evaluate.md / prompts/question.md。回答をもらったら要約を作り直す（prompts/summarize-answer.md）
//   8. ステップの列を小作業のまとまりに分ける（上の層）              prompts/tasks.md
// LLM との入出力は <セッション>/pipeline/ に残す。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Action } from '../capture/actions';
import type { Message, Part, TextResult } from '../llm/llm';
import { clock, describeGroup, groupActions, imagesOf, isWeak, type ActionGroup } from './actionGroups';
import type { Prompts } from './prompts';
import type { Sentence } from './sentences';
import { anchorOf, buildSteps, levelOf, makeGroups, makeTasks, mergeSteps, type Direction, type Evaluation, type SentenceGroup, type Step, type StepSummary, type Task } from './steps';
import type { Window } from './windows';

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

const MAX_LINK_IMAGES = 4;
const MAX_SUMMARY_IMAGES = 2;

// 発話や操作が 1 件も無いセッションでは、ファイル自体が無い
export const readJsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
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
  return [...lines].filter((l) => l.length > 1).slice(0, 100).join('\n') || '（なし）';
}

// steps.json に保存する形（操作は id だけ持つ）
interface StoredStep extends Omit<Step, 'actionGroups' | 'sentences'> {
  sentences: Sentence[];
  actionGroups: { id: string; kind: ActionGroup['kind']; element: string; actions: string[] }[];
}

export class Pipeline {
  readonly steps: Step[] = [];
  // これまでに分けた文（除いた雑音も含む）
  readonly sentences: Sentence[] = [];
  tasks: Task[] = [];
  readonly origin: number;
  private readonly outDir: string;
  private readonly log: (message: string) => void;
  private groupCount = 0;
  private actionGroupCount = 0;
  private windowCount = 0;
  private stepCount = 0;
  private questionCount = 0;

  constructor(private readonly o: PipelineOptions) {
    this.origin = (JSON.parse(readFileSync(join(o.dir, 'session.json'), 'utf8')) as { startedAt: number }).startedAt;
    this.outDir = join(o.dir, 'pipeline');
    mkdirSync(this.outDir, { recursive: true });
    this.log = o.log ?? (() => {});
  }

  // 保存済みの結果から作り直す（記録を止めた後に質問へ答えるときなど）
  static load(o: PipelineOptions): Pipeline {
    const p = new Pipeline(o);
    const actions = new Map(readJsonl<Action>(join(o.dir, 'actions.jsonl')).map((a) => [a.id, a]));
    const stored = JSON.parse(readFileSync(join(o.dir, 'steps.json'), 'utf8')) as { steps: StoredStep[]; tasks?: Task[] };
    if (existsSync(join(o.dir, 'sentences.json'))) p.sentences.push(...(JSON.parse(readFileSync(join(o.dir, 'sentences.json'), 'utf8')) as Sentence[]));
    for (const s of stored.steps) {
      const actionGroups = s.actionGroups.map((g) => {
        const list = g.actions.map((id) => actions.get(id)).filter((a): a is Action => !!a);
        return { id: g.id, kind: g.kind, element: g.element, t0: Math.min(...list.map((a) => a.t0)), t1: Math.max(...list.map((a) => a.t1)), actions: list };
      });
      p.steps.push({ ...s, actionGroups });
    }
    p.tasks = stored.tasks ?? [];
    p.stepCount = p.steps.length;
    p.questionCount = p.steps.filter((s) => s.question).length;
    return p;
  }

  at(t: number): string {
    return clock(t, this.origin);
  }

  private line(s: Sentence): string {
    return `${s.id}: [${this.at(s.t0)}] ${s.text}`;
  }

  // LLM を呼び、入出力を pipeline/ に残す
  private async call<T>(name: string, prompt: string, images: string[] = []): Promise<T> {
    const content: Part[] = [prompt];
    for (const path of images) content.push(`画像 ${path}:`, { image: readFileSync(join(this.o.dir, path)), mime: path.endsWith('.jpg') ? 'image/jpeg' : 'image/png' });
    const r = await this.o.llm.json<T>([{ role: 'user', content }]);
    writeFileSync(join(this.outDir, `${name}.json`), JSON.stringify({ model: r.raw.model, ms: r.raw.ms, images, prompt, response: r.raw.text, value: r.value }, null, 2));
    this.log(`  ${name}: ${r.raw.ms}ms`);
    return r.value;
  }

  // 窓 1 つ分を処理してステップを足す（手順 1〜5）。新しいステップと、合流して中身が変わった前のステップを返す。
  // hints は文字起こしの補正に使うコード（話してから書くこともあるので、分かるなら次の窓の操作も入れる）
  async addWindow(win: Window, hints: Action[] = win.actions): Promise<{ added: Step[]; changed: Step[] }> {
    const tag = `w${String(++this.windowCount).padStart(2, '0')}`;
    this.log(`窓 ${this.windowCount}（${this.at(win.t0)}〜${this.at(win.t1)}、文 ${win.sentences.length}・操作 ${win.actions.length}）`);
    const kept = await this.correct(win, hints, tag);
    if (kept.length === 0 && win.actions.length === 0) return { added: [], changed: [] };

    // 2. 文のまとめ
    let groups: SentenceGroup[] = [];
    if (kept.length > 0) {
      const r = await this.call<{ groups: string[][] }>(`${tag}-2-group`, this.o.prompts.render('group-sentences', { sentences: kept.map((s) => this.line(s)).join('\n') }));
      groups = makeGroups(r.groups ?? [], kept, this.groupCount);
      this.groupCount += groups.length;
    }

    // 3. 操作のまとめ
    const actionGroups = groupActions(win.actions, this.actionGroupCount);
    this.actionGroupCount += actionGroups.length;

    // 4. 結び付け
    const links: Record<string, string[]> = {};
    if (groups.length > 0 && actionGroups.length > 0) {
      const r = await this.call<{ links: { group: string; actions: string[] }[] }>(
        `${tag}-4-link`,
        this.o.prompts.render('link', {
          groups: groups.map((g) => `${g.id}:\n${g.sentences.map((s) => `  [${this.at(s.t0)}] ${s.text}`).join('\n')}`).join('\n'),
          actions: actionGroups.map((g) => describeGroup(g, this.origin)).join('\n'),
        }),
        actionGroups.flatMap(imagesOf).slice(-MAX_LINK_IMAGES),
      );
      const valid = new Set(actionGroups.map((g) => g.id));
      for (const l of r.links ?? []) links[l.group] = (l.actions ?? []).filter((a) => valid.has(a));
    }

    // 5. 操作と結び付かなかった発話（閲覧・エラー表示とだけ結び付いたものを含む）の割り当て。
    //    窓の先頭のまとまりは、前の窓の最後のステップを left として見せる（窓の境目で判断が割れないように）
    const assignments: Record<string, Direction> = {};
    const byGroup = new Map(actionGroups.map((g) => [g.id, g]));
    const hasStrongLink = (id: string) => (links[id] ?? []).some((a) => !isWeak(byGroup.get(a) ?? { kind: 'view' }));
    const previous = this.steps[this.steps.length - 1];
    const unlinked = groups.map((g, i) => ({ g, i })).filter(({ g }) => !hasStrongLink(g.id));
    if (unlinked.length > 0) {
      const text = (g?: SentenceGroup) => (g ? g.sentences.map((s) => s.text).join(' ') : '（なし）');
      const left = (i: number) =>
        i > 0 ? `（${groups[i - 1].id}）: ${text(groups[i - 1])}` : previous ? `（前の区切りの最後のステップ）: ${previous.sentences.map((s) => s.text).join(' ') || '（操作だけ）'}` : ': （なし）';
      const targets = unlinked.map(({ g, i }) => `- 対象 ${g.id}: ${text(g)}\n  left${left(i)}\n  right${groups[i + 1] ? `（${groups[i + 1].id}）` : ''}: ${text(groups[i + 1])}`);
      const r = await this.call<{ assignments: { group: string; direction: Direction }[] }>(
        `${tag}-5-assign`,
        this.o.prompts.render('assign', { transcript: [...(previous?.sentences ?? []), ...kept].map((s) => this.line(s)).join('\n'), targets: targets.join('\n') }),
      );
      for (const a of r.assignments ?? []) if (['left', 'right', 'unrelated'].includes(a.direction)) assignments[a.group] = a.direction;
    }

    const built = buildSteps(groups, actionGroups, links, assignments);
    const changed: Step[] = [];
    // 窓の先頭のまとまりが left に割り当てられたら、そのステップを前の窓の最後のステップに合流させる
    if (previous && groups[0] && assignments[groups[0].id] === 'left') {
      const first = built.find((s) => s.sentences.includes(groups[0].sentences[0]));
      if (first) {
        mergeSteps(previous, first);
        built.splice(built.indexOf(first), 1);
        changed.push(previous);
      }
    }
    for (const s of built) s.id = `st${++this.stepCount}`;
    this.steps.push(...built);
    return { added: built, changed };
  }

  // 1. 文字起こしの補正
  private async correct(win: Window, hints: Action[], tag: string): Promise<Sentence[]> {
    if (win.sentences.length === 0) return [];
    const r = await this.call<{ sentences: { id: string; text: string | null }[] }>(
      `${tag}-1-correct`,
      this.o.prompts.render('correct', { code: codeHints(hints), sentences: win.sentences.map((s) => this.line(s)).join('\n') }),
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

  private describeSentences(step: Step): string {
    return step.sentences.map((s) => `[${this.at(s.t0)}] ${s.text}`).join('\n') || '（発話なし）';
  }

  private describeActions(step: Step): string {
    return step.actionGroups.map((g) => describeGroup(g, this.origin)).join('\n') || '（操作なし）';
  }

  // 6. 要約と、業務・データ固有か一般的なコーディングかの判定
  async summarize(steps: Step[]): Promise<void> {
    const clean = this.sentences.filter((s) => !s.noise);
    await mapLimit(steps, this.o.concurrency ?? 3, async (step) => {
      const context = clean.filter((s) => s.t0 >= step.t0 - 180_000 && s.t0 <= step.t1 + 120_000);
      step.summary = await this.call<StepSummary>(
        `summary-${step.id}`,
        this.o.prompts.render('summarize', {
          transcript: context.map((s) => `[${this.at(s.t0)}] ${s.text}`).join('\n') || '（なし）',
          step_sentences: this.describeSentences(step),
          step_actions: this.describeActions(step),
        }),
        step.actionGroups.flatMap(imagesOf).slice(-MAX_SUMMARY_IMAGES),
      );
      // 判定が無いときは、見落とさないよう業務・データ固有として扱う
      if (step.summary.knowledge !== 'general') step.summary.knowledge = 'domain';
    });
  }

  // 7a. 業務・データ固有のステップの理由を評価する（一般的なコーディングは評価しない）
  async evaluate(steps: Step[]): Promise<void> {
    const targets = steps.filter((s) => s.summary?.knowledge === 'domain');
    await mapLimit(targets, this.o.concurrency ?? 3, async (step) => {
      let evaluation: Evaluation;
      if (step.sentences.length === 0) {
        evaluation = { categories: ['E'], level: 'empty', reason: '発話が無く、操作だけの判断' };
      } else {
        const r = await this.call<{ reason?: string; categories?: string[] }>(
          `evaluate-${step.id}`,
          this.o.prompts.render('evaluate', { decision: step.summary?.decision_and_actions ?? '', sentences: this.describeSentences(step) }),
        );
        const categories = (r.categories ?? []).filter((c) => /^(S|W)-(SR|PK|CA)$|^E$/.test(c));
        evaluation = { categories: categories.length ? categories : ['E'], level: levelOf(categories), reason: r.reason ?? '' };
      }
      step.evaluation = evaluation;
      // 中身が変わったので、質問するかは考え直す
      step.questionSkipped = undefined;
      // 合流して理由が十分になったら、出していた質問は取り下げる
      if (evaluation.level === 'strong' && step.question?.status === 'open') step.question.status = 'dismissed';
    });
  }

  // 7b. 業務・データ固有で理由が弱い・無いステップに、質問を 1 つ作る。質問を作ったステップを返す
  async askQuestions(steps: Step[]): Promise<Step[]> {
    const targets = steps.filter((s) => s.summary?.knowledge === 'domain' && s.evaluation && s.evaluation.level !== 'strong' && !s.question && !s.questionSkipped);
    // 同じことを重ねて聞かないよう、これまでの質問（と回答）を見せながら 1 つずつ作る
    for (const step of targets) {
      const asked = this.steps
        .filter((s) => s.question)
        .map((s) => `- ${s.question!.text}${s.question!.answer ? ` → 回答: ${s.question!.answer.text}` : s.question!.status === 'dismissed' ? '（答えなかった）' : ''}`);
      const r = await this.call<{ question?: string | null; skip?: string }>(
        `question-${step.id}`,
        this.o.prompts.render('question', {
          decision: step.summary?.decision_and_actions ?? '',
          sentences: this.describeSentences(step),
          reason: step.evaluation?.reason ?? '',
          asked: asked.length > 0 ? asked.join('\n') : '（まだ無い）',
        }),
      );
      if (r.question) step.question = { id: `q${++this.questionCount}`, text: r.question, status: 'open', createdAt: Date.now(), anchor: anchorOf(step) };
      else step.questionSkipped = r.skip ?? '聞くことが無い';
    }
    return targets.filter((s) => s.question);
  }

  // 回答を受け取り、回答込みで要約を作り直す（論文 A.4.2）
  async answer(stepId: string, text: string, via: 'text' | 'voice'): Promise<Step> {
    const step = this.steps.find((s) => s.id === stepId);
    if (!step?.question) throw new Error(`質問のあるステップ ${stepId} が見つからない`);
    step.question.status = 'answered';
    step.question.answer = { text, via, at: Date.now() };
    const summary = await this.call<StepSummary>(
      `answer-${step.id}`,
      this.o.prompts.render('summarize-answer', {
        decision: step.summary?.decision_and_actions ?? '',
        rationale: step.summary?.rationale ?? '',
        progression: step.summary?.progression ?? '',
        sentences: this.describeSentences(step),
        actions: this.describeActions(step),
        question: step.question.text,
        answer: text,
      }),
    );
    step.summary = { ...summary, knowledge: summary.knowledge === 'general' ? 'general' : 'domain' };
    this.save();
    return step;
  }

  dismiss(stepId: string): void {
    const step = this.steps.find((s) => s.id === stepId);
    if (step?.question) step.question.status = 'dismissed';
    this.save();
  }

  // 8. 小作業のまとまり
  async groupTasks(): Promise<void> {
    if (this.steps.length === 0) return;
    const ordered = [...this.steps].sort((a, b) => a.t0 - b.t0);
    const label = (s: Step) => (s.summary?.knowledge === 'general' ? '一般的なコーディング' : '業務・データ固有');
    const r = await this.call<{ tasks: { title?: string; summary?: string; steps?: string[] }[] }>(
      '8-tasks',
      this.o.prompts.render('tasks', {
        steps: ordered.map((s) => `${s.id} [${this.at(s.t0)}]（${label(s)}）\n  判断: ${s.summary?.decision_and_actions}\n  理由: ${s.summary?.rationale}`).join('\n'),
      }),
    );
    this.tasks = makeTasks(r.tasks ?? [], ordered);
  }

  save(): void {
    const steps: StoredStep[] = [...this.steps]
      .sort((a, b) => a.t0 - b.t0)
      .map((s) => ({
        ...s,
        sentences: s.sentences.map(({ id, t0, t1, text, original }) => ({ id, t0, t1, text, original })),
        actionGroups: s.actionGroups.map((g) => ({ id: g.id, kind: g.kind, element: g.element, actions: g.actions.map((a) => a.id) })),
      }));
    writeFileSync(join(this.o.dir, 'sentences.json'), JSON.stringify(this.sentences, null, 2));
    writeFileSync(join(this.o.dir, 'steps.json'), JSON.stringify({ version: 3, generatedAt: Date.now(), tasks: this.tasks, steps }, null, 2));
  }
}
