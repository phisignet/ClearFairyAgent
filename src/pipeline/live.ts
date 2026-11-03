// 記録中に、たまった発話と操作から少しずつ意思決定ステップを作り、質問を出す（論文のリアルタイム処理）。vscode に依存しない。
// 論文は「操作ログ 20 件超・文 20 文超・最後の操作から 3 秒の停止」で区切っていた。最初は LLM を呼ぶ回数を抑えるため
// 「20 超か 45 秒の無活動」にしたが、手を動かし続けていると 20 文たまるまで区切られず、質問が 1〜3 分遅れた（本人の感想も「遅い」）。
// そこで、文か操作が 10 を超えたとき、15 秒なにも起きなかったとき、いちばん古い発話・操作から 40 秒たったときに区切る。
// 数と時間で区切るときは、話している途中の発話を割らないよう、直近 10 秒分は次に回す。
import type { Action } from '../capture/actions';
import { persistentDiagnostics } from './actionGroups';
import { Pipeline, type PipelineOptions } from './engine';
import { toSentences, type Sentence, type Utterance } from './sentences';
import type { AnswerVia, Step } from './steps';
import type { Window } from './windows';

const MAX_SENTENCES = 10;
const MAX_ACTIONS = 10;
const IDLE_MS = 15_000;
const MAX_WAIT_MS = 40_000;
const TAIL_MS = 10_000;
const TICK_MS = 2_000;

export interface LiveOptions extends PipelineOptions {
  // 新しく質問を作ったとき
  onQuestions?: (steps: Step[]) => void;
  // ステップが増えた・変わったとき
  onChange?: () => void;
}

export class LivePipeline {
  readonly pipeline: Pipeline;
  private sentenceCount = 0;
  private pendingSentences: Sentence[] = [];
  private pendingActions: Action[] = [];
  private lastActivity = Date.now();
  private queue: Promise<void> = Promise.resolve();
  private busy = false;
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly o: LiveOptions) {
    this.pipeline = new Pipeline(o);
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  addUtterance(u: Utterance): void {
    const sentences = toSentences([u], this.sentenceCount);
    this.sentenceCount += sentences.length;
    this.pipeline.sentences.push(...sentences);
    this.pendingSentences.push(...sentences.filter((s) => !s.noise));
    this.lastActivity = Date.now();
  }

  addAction(a: Action): void {
    this.pendingActions.push(a);
    this.lastActivity = Date.now();
  }

  // 閲覧とエラー表示は数に入れない（見ているだけ・出ているだけで区切らない）
  private countActions(): number {
    return this.pendingActions.filter((a) => a.kind !== 'view' && a.kind !== 'diagnostics').length;
  }

  private tick(): void {
    if (this.busy || (this.pendingSentences.length === 0 && this.countActions() === 0)) return;
    const now = Date.now();
    const oldest = Math.min(...this.pendingSentences.map((s) => s.t0), ...this.pendingActions.map((a) => a.t0));
    if (now - this.lastActivity >= IDLE_MS) this.flush(Infinity);
    else if (this.pendingSentences.length >= MAX_SENTENCES || this.countActions() >= MAX_ACTIONS || now - oldest >= MAX_WAIT_MS) this.flush(now - TAIL_MS);
  }

  private flush(cutoff: number): void {
    const sentences = this.pendingSentences.filter((s) => s.t1 <= cutoff);
    const actions = this.pendingActions.filter((a) => a.t1 <= cutoff);
    if (sentences.length === 0 && actions.length === 0) return;
    this.pendingSentences = this.pendingSentences.filter((s) => s.t1 > cutoff);
    this.pendingActions = this.pendingActions.filter((a) => a.t1 > cutoff);
    const times = [...sentences.map((s) => s.t0), ...actions.map((a) => a.t0)];
    const win: Window = { t0: Math.min(...times), t1: Math.max(...times), sentences, actions: persistentDiagnostics(actions) };
    this.busy = true;
    this.enqueue(async () => {
      const { added, changed } = await this.pipeline.addWindow(win);
      const touched = [...changed, ...added];
      await this.pipeline.summarize(touched);
      await this.pipeline.evaluate(touched);
      const asked = await this.pipeline.askQuestions(touched);
      this.pipeline.save();
      this.o.onChange?.();
      if (asked.length > 0) this.o.onQuestions?.(asked);
    })
      // 失敗は enqueue で記録済み。次の窓は処理を続ける
      .catch(() => undefined)
      .finally(() => (this.busy = false));
  }

  // 窓の処理と回答の反映が同じ結果を同時に書き換えないよう、順番に処理する
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.queue.then(job);
    this.queue = result.then(
      () => undefined,
      (e) => this.o.log?.(`記録中の処理に失敗: ${e instanceof Error ? (e.stack ?? e.message) : e}`),
    );
    return result;
  }

  answer(stepId: string, text: string, via: AnswerVia): Promise<Step> {
    return this.enqueue(() => this.pipeline.answer(stepId, text, via));
  }

  acceptInference(stepId: string): Promise<Step> {
    return this.enqueue(() => this.pipeline.acceptInference(stepId));
  }

  rejectInference(stepId: string): Promise<void> {
    return this.enqueue(async () => this.pipeline.rejectInference(stepId));
  }

  dismiss(stepId: string): Promise<void> {
    return this.enqueue(async () => this.pipeline.dismiss(stepId));
  }

  // 止めたら残りを処理し、小作業のまとまりを作って保存する
  async finish(): Promise<Pipeline> {
    clearInterval(this.timer);
    this.flush(Infinity);
    await this.enqueue(async () => {
      await this.pipeline.groupTasks();
      this.pipeline.save();
    });
    this.o.onChange?.();
    return this.pipeline;
  }
}
