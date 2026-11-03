// 意思決定ステップの組み立て（論文の CLEAR）。vscode に依存しない。
// 発話のまとまり・操作のまとまり・その結び付き・残った発話の割り当てから、ステップを作る。
import { isWeak, type ActionGroup } from './actionGroups';
import type { Sentence } from './sentences';

export interface SentenceGroup {
  id: string;
  t0: number;
  t1: number;
  sentences: Sentence[];
}

export type Direction = 'left' | 'right' | 'unrelated';

export interface StepSummary {
  decision_and_actions: string;
  rationale: string;
  progression: string;
  // domain: 業務・データ固有（その会社・データだからこその事実や方針） / general: 一般的なコーディング（AI がもともと知っていること）
  knowledge: 'domain' | 'general';
  // decision: 扱い方・処理・見せ方を選んだ / check: 中身を見ただけで、まだ何も選んでいない（理由は評価せず、質問もしない）。
  // 無ければ decision（これを足す前の記録）
  step_type?: 'decision' | 'check';
}

// 小作業のまとまり（ステップの上の層）
export interface Task {
  id: string;
  t0: number;
  t1: number;
  title: string;
  summary: string;
  steps: string[];
}

export interface Step {
  id: string;
  t0: number;
  t1: number;
  // linked: 発話と操作 / talk: 発話だけ / action-only: 説明の無い操作（暗黙の判断）
  kind: 'linked' | 'talk' | 'action-only';
  sentences: Sentence[];
  actionGroups: ActionGroup[];
  summary?: StepSummary;
  // 業務・データ固有のステップだけ評価する
  evaluation?: Evaluation;
  // 業務・データ固有で、理由が弱い・無いステップへの質問
  question?: Question;
  // 質問を作らなかった理由（聞いたことの繰り返し、データを眺めただけ など）
  questionSkipped?: string;
  // 質問と並べて見せる、本人の過去の判断から推測した理由
  inference?: Inference;
}

// 論文の Rationale Evaluation。categories は S-SR / S-PK / S-CA / W-SR / W-PK / W-CA / E
export interface Evaluation {
  categories: string[];
  level: 'strong' | 'weak' | 'empty';
  reason: string;
}

// 質問を出す場所（その判断の最後の編集・実行など）
export interface Anchor {
  file: string;
  // 文書の URI（セルを足すと番号がずれるので、分かるときはこちらで探す）
  uri?: string;
  cell?: number;
  line?: number;
}

export interface Question {
  id: string;
  // confirm: 前に説明した理由からの推測で足りるので、新しく聞かずに推測が合っているかだけ確かめる（無ければ ask）
  kind?: 'ask' | 'confirm';
  text: string;
  status: 'open' | 'answered' | 'dismissed';
  createdAt: number;
  anchor?: Anchor;
  answer?: { text: string; via: AnswerVia; at: number };
}

// inference: 推測した理由を「合っている」としてそのまま回答にした
export type AnswerVia = 'text' | 'voice' | 'inference';

// 推測の元にする、本人の過去の判断（業務・データ固有で、理由が十分だったか質問に答えたもの）
export interface PastDecision {
  // 前の記録ならそのフォルダ名。同じ記録なら無し
  session?: string;
  step: string;
  at: number;
  decision: string;
  rationale: string;
}

// 過去の判断から推測した理由（論文の Rationale Inference）。質問と並べて見せ、本人が確かめる
export interface Inference {
  text: string;
  // そう推測した筋道（どの判断のどこが重なるか）
  reasoning: string;
  basis: PastDecision[];
  // open: まだ確かめていない / accepted: 合っている / revised: 推測を見て自分の言葉で答えた / rejected: 違う
  status: 'open' | 'accepted' | 'revised' | 'rejected';
  at: number;
}

export const NO_REASON = '（理由は述べていない）';

// 推測の元にできる判断か
export function isJustified(s: Pick<Step, 'summary' | 'evaluation' | 'question'>): boolean {
  return s.summary?.knowledge === 'domain' && (s.evaluation?.level === 'strong' || s.question?.status === 'answered') && !s.summary.rationale.includes(NO_REASON);
}

// 論文どおり、Strong を 1 つでも含めば strong、Weak だけなら weak、どちらも無ければ empty
export function levelOf(categories: string[]): Evaluation['level'] {
  if (categories.some((c) => c.startsWith('S-'))) return 'strong';
  if (categories.some((c) => c.startsWith('W-'))) return 'weak';
  return 'empty';
}

// 質問を出す場所。最後の編集かセルの実行を優先し、無ければ閲覧などから選ぶ
export function anchorOf(step: Step): Anchor | undefined {
  const actions = step.actionGroups.flatMap((g) => g.actions).sort((a, b) => b.t0 - a.t0);
  const a = actions.find((x) => x.kind === 'edit' || x.kind === 'cell-run') ?? actions.find((x) => x.kind === 'view' || x.kind === 'debug' || x.kind === 'diagnostics');
  switch (a?.kind) {
    case 'edit':
      return { file: a.file, uri: a.uri, cell: a.cell, line: a.lines[0] };
    case 'cell-run':
      return { file: a.file, uri: a.uri, cell: a.cell };
    case 'view':
      return { file: a.file, uri: a.uri, line: a.lines?.[0], cell: a.cells?.[0] };
    case 'debug':
      return a.file ? { file: a.file, line: a.line } : undefined;
    case 'diagnostics':
      return { file: a.file, cell: a.cell };
    default:
      return undefined;
  }
}

// 同じ操作に結び付いた発話のまとまりを同じステップにするのは、間に挟まるまとまりが 1 つまでのとき
const MAX_LINK_DISTANCE = 2;
// 説明の無い操作は、同じ要素を扱うステップが近くにあればそこに入れる
const SAME_ELEMENT_WINDOW_MS = 120_000;
// 閲覧・エラー表示は、近くのステップの補足にする（それだけではステップにしない）
const CONTEXT_WINDOW_MS = 30_000;

export function makeGroups(ids: string[][], sentences: Sentence[], startIndex: number): SentenceGroup[] {
  const byId = new Map(sentences.map((s) => [s.id, s]));
  const used = new Set<string>();
  const groups: SentenceGroup[] = [];
  for (const g of ids) {
    // 同じ文が別のまとまりや同じまとまりに重ねて入っていたら、最初の 1 回だけ使う
    const members: Sentence[] = [];
    for (const id of g) {
      const s = byId.get(id);
      if (s && !used.has(s.id)) {
        used.add(s.id);
        members.push(s);
      }
    }
    if (members.length === 0) continue;
    members.sort((a, b) => a.t0 - b.t0);
    groups.push({ id: `G${startIndex + groups.length + 1}`, t0: members[0].t0, t1: members[members.length - 1].t1, sentences: members });
  }
  // LLM が入れ忘れた文は、それだけのまとまりにする（漏れなく残すため）
  for (const s of sentences) {
    if (!used.has(s.id)) groups.push({ id: `G${startIndex + groups.length + 1}`, t0: s.t0, t1: s.t1, sentences: [s] });
  }
  return groups.sort((a, b) => a.t0 - b.t0);
}

const spanOf = (s: { sentences: Sentence[]; actionGroups: ActionGroup[] }) => {
  const times = [...s.sentences.flatMap((x) => [x.t0, x.t1]), ...s.actionGroups.flatMap((g) => [g.t0, g.t1])];
  return { t0: Math.min(...times), t1: Math.max(...times) };
};

const distance = (a: { t0: number; t1: number }, b: { t0: number; t1: number }) => Math.max(0, a.t0 - b.t1, b.t0 - a.t1);

export function buildSteps(groups: SentenceGroup[], actionGroups: ActionGroup[], links: Record<string, string[]>, assignments: Record<string, Direction>): Step[] {
  const parent = groups.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a: number, b: number) => {
    parent[find(b)] = find(a);
  };

  // 1. 同じ操作に結び付いた、近くの発話のまとまりは同じステップにする。操作は最初に結び付いたまとまりの側に置く。
  //    閲覧・エラー表示を共有しているだけでは同じステップにしない（弱い結び付き）
  const byId = new Map(actionGroups.map((g) => [g.id, g]));
  const owner = new Map<string, number>();
  groups.forEach((g, i) => {
    for (const a of links[g.id] ?? []) {
      const first = owner.get(a);
      const ag = byId.get(a);
      if (first === undefined) owner.set(a, i);
      else if (ag && !isWeak(ag) && i - first <= MAX_LINK_DISTANCE) union(first, i);
    }
  });

  // 2. 操作と結び付かなかった発話は、割り当てに従って前後のまとまりと同じステップにする
  groups.forEach((g, i) => {
    const d = assignments[g.id];
    if (d === 'left' && i > 0) union(i - 1, i);
    if (d === 'right' && i < groups.length - 1) union(i, i + 1);
  });

  const steps = new Map<number, Step>();
  const stepOf = (i: number) => {
    const root = find(i);
    let s = steps.get(root);
    if (!s) steps.set(root, (s = { id: '', t0: 0, t1: 0, kind: 'talk', sentences: [], actionGroups: [] }));
    return s;
  };
  groups.forEach((g, i) => stepOf(i).sentences.push(...g.sentences));
  for (const [a, i] of owner) {
    const g = byId.get(a);
    if (g) stepOf(i).actionGroups.push(g);
  }

  // 3. どの発話とも結び付かなかった操作
  const list = [...steps.values()];
  const nearest = (g: ActionGroup, maxGap: number, ok: (s: Step) => boolean) => {
    let best: Step | undefined;
    let bestGap = Infinity;
    for (const s of list) {
      if (!ok(s) || (s.sentences.length === 0 && s.actionGroups.length === 0)) continue;
      const gap = distance(spanOf(s), g);
      if (gap < bestGap) {
        best = s;
        bestGap = gap;
      }
    }
    return bestGap <= maxGap ? best : undefined;
  };
  let orphans: Step | undefined;
  for (const g of [...actionGroups].sort((a, b) => a.t0 - b.t0)) {
    if (owner.has(g.id)) {
      orphans = undefined;
      continue;
    }
    const sameElement = nearest(g, SAME_ELEMENT_WINDOW_MS, (s) => s.kind !== 'action-only' && s.actionGroups.some((x) => x.element === g.element));
    if (sameElement) {
      sameElement.actionGroups.push(g);
      continue;
    }
    if (g.kind === 'view' || g.kind === 'diagnostics') {
      nearest(g, CONTEXT_WINDOW_MS, () => true)?.actionGroups.push(g);
      continue;
    }
    // 説明の無い操作は、同じ要素への連続をまとめて「操作だけのステップ」にする（説明の無い暗黙の判断）
    if (orphans && orphans.actionGroups[orphans.actionGroups.length - 1].element === g.element) {
      orphans.actionGroups.push(g);
    } else {
      orphans = { id: '', t0: 0, t1: 0, kind: 'action-only', sentences: [], actionGroups: [g] };
      list.push(orphans);
    }
  }

  for (const s of list) {
    s.sentences.sort((a, b) => a.t0 - b.t0);
    s.actionGroups.sort((a, b) => a.t0 - b.t0);
    Object.assign(s, spanOf(s));
    s.kind = s.sentences.length === 0 ? 'action-only' : s.actionGroups.length === 0 ? 'talk' : 'linked';
  }
  return list.filter((s) => s.sentences.length > 0 || s.actionGroups.length > 0).sort((a, b) => a.t0 - b.t0);
}

// ステップ from を into に合流させる（窓の境目で割れた判断をつなぐため）
export function mergeSteps(into: Step, from: Step): void {
  into.sentences.push(...from.sentences);
  into.actionGroups.push(...from.actionGroups);
  into.sentences.sort((a, b) => a.t0 - b.t0);
  into.actionGroups.sort((a, b) => a.t0 - b.t0);
  Object.assign(into, spanOf(into));
  into.kind = into.sentences.length === 0 ? 'action-only' : into.actionGroups.length === 0 ? 'talk' : 'linked';
}

// LLM が返した小作業のまとまりを、すべてのステップが時刻順に 1 回ずつ入るように整える。
// 入れ忘れたステップは直前のまとまりに入れ、同じステップを重ねて入れていたら最初のものだけ使う
export function makeTasks(raw: { title?: string; summary?: string; steps?: string[] }[], steps: Step[]): Task[] {
  const order = new Map(steps.map((s, i) => [s.id, i]));
  const owner = new Array<number>(steps.length).fill(-1);
  raw.forEach((t, ti) => {
    for (const id of t.steps ?? []) {
      const i = order.get(id);
      if (i !== undefined && owner[i] === -1) owner[i] = ti;
    }
  });
  for (let i = 0; i < steps.length; i++) if (owner[i] === -1) owner[i] = i > 0 ? owner[i - 1] : Math.max(0, owner.find((o) => o >= 0) ?? 0);
  // 時刻順に見て、まとまりが切り替わるところで区切る（飛び飛びに割り当てられていても連続した塊にする）
  const tasks: Task[] = [];
  steps.forEach((s, i) => {
    const last = tasks[tasks.length - 1];
    const source = raw[owner[i]] ?? {};
    if (last && i > 0 && owner[i] === owner[i - 1]) {
      last.steps.push(s.id);
      last.t1 = Math.max(last.t1, s.t1);
    } else {
      tasks.push({ id: `t${tasks.length + 1}`, t0: s.t0, t1: s.t1, title: source.title ?? '（無題）', summary: source.summary ?? '', steps: [s.id] });
    }
  });
  return tasks;
}
