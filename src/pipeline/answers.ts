// 記録を止めた後の、質問への回答の反映。vscode に依存しない。
// 回答ごとに保存済みの結果を読み直して保存するので、重なると後の保存が先の回答を消す。同じ記録への書き込みは順番に行う。
import { Pipeline, type PipelineOptions } from './engine';
import type { AnswerVia } from './steps';

// 回答を反映する先（記録中は LivePipeline、それ以外は SavedAnswers）
export interface AnswerTarget {
  answer(stepId: string, text: string, via: AnswerVia): Promise<unknown>;
  acceptInference(stepId: string): Promise<unknown>;
  rejectInference(stepId: string): Promise<unknown>;
  dismiss(stepId: string): Promise<unknown>;
}

// 頼まれた順に 1 つずつ処理する。失敗しても次の処理は続ける（失敗は呼び出し側に返す）
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(job);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class SavedAnswers {
  private readonly queues = new Map<string, SerialQueue>();

  constructor(private readonly options: (dir: string) => PipelineOptions) {}

  private queueOf(dir: string): SerialQueue {
    let queue = this.queues.get(dir);
    if (!queue) this.queues.set(dir, (queue = new SerialQueue()));
    return queue;
  }

  target(dir: string): AnswerTarget {
    const queue = this.queueOf(dir);
    const run = <T>(job: (p: Pipeline) => Promise<T> | T) => queue.run(() => job(Pipeline.load(this.options(dir))));
    return {
      answer: (stepId, text, via) => run((p) => p.answer(stepId, text, via)),
      acceptInference: (stepId) => run((p) => p.acceptInference(stepId)),
      rejectInference: (stepId) => run((p) => p.rejectInference(stepId)),
      dismiss: (stepId) => run((p) => p.dismiss(stepId)),
    };
  }
}
