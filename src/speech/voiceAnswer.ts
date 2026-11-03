// 記録していないときに、質問へ音声で答えるための短い録音。止めるまでの発話をつないで返す。
// （記録中は、作業セッションの録音をそのまま使う。WorkSession.beginAnswer）
import * as vscode from 'vscode';
import { isNoiseUtterance } from '../pipeline/sentences';
import { firstLine, SpeechWorker } from './client';
import type { ModelPaths } from './modelStore';

export class VoiceAnswer {
  private readonly parts: string[] = [];
  speaking = false;
  private stopping = false;

  private constructor(private readonly worker: SpeechWorker) {}

  static async start(o: {
    workerScript: string;
    model: ModelPaths;
    threads: number;
    log: vscode.OutputChannel;
    onText: (text: string) => void;
    // 始めた後に録音が止まったとき（マイクから音が届かないなど）
    onError: (message: string) => void;
  }): Promise<VoiceAnswer> {
    const worker = new SpeechWorker(o.workerScript, o.log);
    const answer = new VoiceAnswer(worker);
    let started = false;
    worker.onEvent((e) => {
      if (e.type === 'level') answer.speaking = e.speaking;
      if (e.type === 'utterance' && !isNoiseUtterance(e.text)) {
        answer.parts.push(e.text);
        o.onText(answer.parts.join(''));
      }
      if (started && !answer.stopping && e.type === 'error') o.onError(firstLine(e.message));
      if (started && !answer.stopping && e.type === 'exit') o.onError(`音声ワーカーが終了しました（code=${e.code}）`);
    });
    try {
      await worker.request(
        {
          type: 'start',
          options: { modelDir: o.model.modelDir, vadModel: o.model.vadModel, recorder: 'pvrecorder', numThreads: o.threads, padBefore: 1.0, padAfter: 0.2, autoGain: true, initialGainDb: 10 },
        },
        'ready',
        120_000,
      );
    } catch (e) {
      worker.dispose();
      throw e;
    }
    started = true;
    return answer;
  }

  async stop(): Promise<string> {
    this.stopping = true;
    try {
      // 話し終わりの発話も文字にしてから止める
      if (this.worker.running) await this.worker.request({ type: 'stop' }, 'stopped', 60_000);
    } catch {
      // 録音が先に止まっていたら、それまでに聞き取った分を返す
    } finally {
      this.worker.dispose();
    }
    return this.parts.join('');
  }
}
