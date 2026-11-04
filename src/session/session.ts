// 作業セッション: 録音（音声ワーカー）と操作の記録を同時に開始・停止し、.clearfairy/sessions/<日時>/ に保存する。
// 保存するもの: session.json（概要）、utterances.jsonl（発話ごとの文字起こし）、actions.jsonl（操作）、images/（セルの画像出力）。
// 設定で有効にしたときだけ audio.wav（録音）と events.jsonl（生のイベント）も残す
import { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { ActionRecorder } from '../capture/actionRecorder';
import type { Action } from '../capture/actions';
import { EventLog } from '../capture/eventLog';
import type { SpeechModelId } from '../config';
import { writeSessionInfo, type SessionInfo } from '../pipeline/records';
import { isNoiseUtterance, type Utterance } from '../pipeline/sentences';
import { firstLine, SpeechWorker } from '../speech/client';
import type { ModelPaths } from '../speech/modelStore';
import { MIC_OPTIONS } from '../speech/protocol';
import type { VoiceCapture } from '../speech/voiceAnswer';

export interface StartOptions {
  root: string;
  workerScript: string;
  model: ModelPaths;
  speechModel: SpeechModelId;
  threads: number;
  keepAudio: boolean;
  keepEvents: boolean;
  log: vscode.OutputChannel;
  // 試験用: マイクの代わりに WAV を流し込む。フォーカスの有無も差し替える
  input?: { wav: string; speed: number; isFocused: () => boolean };
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// 作業レベルの記録の場所。録音しない人のワークスペースを汚さないよう、ここでは作らない（prepareSessionsRoot）
export function sessionsRoot(context: Pick<vscode.ExtensionContext, 'globalStorageUri'>): string {
  return join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath, '.clearfairy', 'sessions');
}

// 記録を始めるときに、記録の場所を用意する。中の .gitignore で git から外し、記録の読み方を隣に置く
// （Copilot には chatSkills で渡すが、他のツールには届かないので）
export function prepareSessionsRoot(context: Pick<vscode.ExtensionContext, 'globalStorageUri' | 'asAbsolutePath'>): string {
  const sessions = sessionsRoot(context);
  const root = dirname(sessions);
  mkdirSync(sessions, { recursive: true });
  if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), '*\n');
  copyFileSync(context.asAbsolutePath(join('skills', 'clearfairy-records', 'SKILL.md')), join(root, 'README.md'));
  return sessions;
}

export class WorkSession {
  private readonly utteranceEmitter = new vscode.EventEmitter<Utterance>();
  readonly onUtterance = this.utteranceEmitter.event;
  // 音声ワーカーが途中で落ちたとき
  private readonly failEmitter = new vscode.EventEmitter<string>();
  readonly onFail = this.failEmitter.event;
  // 質問に音声で答えている間の発話（作業の文字起こしには入れない）。これまでに話した回答の全文を通知する
  private readonly answerEmitter = new vscode.EventEmitter<string>();
  readonly onAnswerText = this.answerEmitter.event;
  private answering: string[] | undefined;
  private quietWaiters: (() => void)[] = [];
  level = 0;
  // VAD が発話の途中と見ているか
  speaking = false;
  gainDb = 0;
  utterances = 0;
  private stopping = false;

  private constructor(
    readonly info: SessionInfo,
    readonly dir: string,
    private readonly worker: SpeechWorker,
    private readonly recorder: ActionRecorder,
    private readonly events: EventLog | undefined,
  ) {}

  get onAction(): vscode.Event<Action> {
    return this.recorder.onAction;
  }

  get actions(): number {
    return this.recorder.count;
  }

  // 質問に音声で答え始める。止めるまでの発話は、作業の文字起こしに入れず回答として扱う
  captureAnswer(onText: (text: string) => void): VoiceCapture {
    this.answering = [];
    const sub = this.onAnswerText(onText);
    const session = this;
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

  // ボタンを押す直前の言葉も回答に入れるため、VAD が区切って（無音 0.5 秒）文字にし終えるまで待ってから閉じる。
  // 文字にする処理は音声の受け取りと同じ流れで動くので、その後に届く「話していない」通知は、文字にし終えた後に来る
  // 記録を止めた後なら、もう待つものは無い
  private async endAnswer(): Promise<string> {
    if (!this.stopping) {
      await new Promise((r) => setTimeout(r, 600));
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 8000);
        this.quietWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const text = this.answering?.join('') ?? '';
    this.answering = undefined;
    return text;
  }

  static async start(o: StartOptions): Promise<WorkSession> {
    const id = stamp();
    const dir = join(o.root, id);
    mkdirSync(dir, { recursive: true });
    const info: SessionInfo = { id, startedAt: Date.now(), workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, speechModel: o.speechModel };

    // マイクが無いなどの失敗を先に知るため、録音を先に始める
    const worker = new SpeechWorker(o.workerScript, o.log);
    let ready;
    try {
      ready = await worker.request(
        {
          type: 'start',
          options: {
            ...MIC_OPTIONS,
            ...(o.input && { recorder: 'file', inputWav: o.input.wav, speed: o.input.speed }),
            modelDir: o.model.modelDir,
            vadModel: o.model.vadModel,
            numThreads: o.threads,
            saveWav: o.keepAudio ? join(dir, 'audio.wav') : undefined,
          },
        },
        'ready',
        120_000,
      );
    } catch (e) {
      worker.dispose();
      throw e;
    }
    info.device = ready.device;
    const session = new WorkSession(info, dir, worker, new ActionRecorder(dir, o.input?.isFocused), o.keepEvents ? new EventLog(join(dir, 'events.jsonl')) : undefined);
    session.listen();
    writeSessionInfo(dir, info);
    return session;
  }

  private listen(): void {
    this.worker.onEvent((e) => {
      switch (e.type) {
        case 'level':
          this.level = e.rms;
          this.gainDb = e.gainDb;
          this.speaking = e.speaking;
          if (!e.speaking) for (const f of this.quietWaiters.splice(0)) f();
          break;
        case 'utterance': {
          const u: Utterance = { start: e.start, end: e.end, text: e.text };
          if (this.answering) {
            // 黙っている間に Whisper が作る「ご視聴ありがとうございました」などは回答に入れない
            const noise = isNoiseUtterance(e.text);
            appendFileSync(join(this.dir, 'answers.jsonl'), JSON.stringify(noise ? { ...u, noise: true } : u) + '\n');
            if (noise) break;
            this.answering.push(e.text);
            this.answerEmitter.fire(this.answering.join(''));
            break;
          }
          this.utterances++;
          appendFileSync(join(this.dir, 'utterances.jsonl'), JSON.stringify(u) + '\n');
          this.utteranceEmitter.fire(u);
          break;
        }
        case 'error':
          this.failEmitter.fire(firstLine(e.message));
          break;
        case 'exit':
          if (!this.stopping) this.failEmitter.fire(`音声ワーカーが終了しました（code=${e.code}）`);
          break;
      }
    });
  }

  async stop(): Promise<SessionInfo> {
    this.stopping = true;
    let audio: { audioSec: number; speechSec: number; decodeSec: number; lostSec?: number } = { audioSec: 0, speechSec: 0, decodeSec: 0 };
    try {
      if (this.worker.running) audio = await this.worker.request({ type: 'stop' }, 'stopped', 60_000);
    } catch {
      // 止めるときの失敗は記録を残すことを優先して無視する
    }
    this.worker.dispose();
    for (const f of this.quietWaiters.splice(0)) f();
    await this.recorder.stop();
    this.events?.dispose();
    this.info.endedAt = Date.now();
    this.info.stats = { audioSec: audio.audioSec, speechSec: audio.speechSec, decodeSec: audio.decodeSec, lostSec: audio.lostSec, utterances: this.utterances, actions: this.recorder.count };
    writeSessionInfo(this.dir, this.info);
    this.utteranceEmitter.dispose();
    this.failEmitter.dispose();
    this.answerEmitter.dispose();
    return this.info;
  }
}
