// 作業セッション: 録音（音声ワーカー）と操作の記録を同時に開始・停止し、.clearfairy/sessions/<日時>/ に保存する。
// 保存するもの: session.json（概要）、utterances.jsonl（発話ごとの文字起こし）、actions.jsonl（操作）、
// events.jsonl（生のイベント）、images/（セルの画像出力）、audio.wav（録音。設定で止められる）
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ActionRecorder } from '../capture/actionRecorder';
import type { Action } from '../capture/actions';
import { EventLog } from '../capture/eventLog';
import type { SpeechModelId } from '../config';
import { SpeechWorker } from '../speech/client';
import type { ModelPaths } from '../speech/modelStore';
import type { RecorderKind } from '../speech/protocol';

export interface Utterance {
  start: number;
  end: number;
  text: string;
}

export interface SessionInfo {
  id: string;
  startedAt: number;
  endedAt?: number;
  workspace?: string;
  speechModel: SpeechModelId;
  device?: string;
  stats?: { audioSec: number; speechSec: number; decodeSec: number; utterances: number; actions: number };
}

export interface StartOptions {
  root: string;
  workerScript: string;
  model: ModelPaths;
  speechModel: SpeechModelId;
  threads: number;
  keepAudio: boolean;
  log: vscode.OutputChannel;
  // 試験用: マイクの代わりに WAV を流し込む
  input?: { recorder: RecorderKind; wav?: string; speed?: number };
}

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// 作業レベルの記録はワークスペースの .clearfairy/ に置き、中の .gitignore で git から外す
export function sessionsRoot(context: vscode.ExtensionContext): string {
  const root = join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? context.globalStorageUri.fsPath, '.clearfairy');
  mkdirSync(join(root, 'sessions'), { recursive: true });
  if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), '*\n');
  return join(root, 'sessions');
}

export class WorkSession {
  private readonly utteranceEmitter = new vscode.EventEmitter<Utterance>();
  readonly onUtterance = this.utteranceEmitter.event;
  // 音声ワーカーが途中で落ちたとき
  private readonly failEmitter = new vscode.EventEmitter<string>();
  readonly onFail = this.failEmitter.event;
  level = 0;
  gainDb = 0;
  utterances = 0;
  private stopping = false;

  private constructor(
    readonly info: SessionInfo,
    readonly dir: string,
    private readonly worker: SpeechWorker,
    private readonly recorder: ActionRecorder,
    private readonly events: EventLog,
  ) {}

  get onAction(): vscode.Event<Action> {
    return this.recorder.onAction;
  }

  get actions(): number {
    return this.recorder.count;
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
            modelDir: o.model.modelDir,
            vadModel: o.model.vadModel,
            recorder: o.input?.recorder ?? 'pvrecorder',
            inputWav: o.input?.wav,
            speed: o.input?.speed,
            numThreads: o.threads,
            // 声が小さいと VAD の区間の開始が遅れて語頭が欠けるので、余白を取り、音量も自動で上げる（Phase 0 で確認）
            padBefore: 1.0,
            padAfter: 0.2,
            autoGain: true,
            initialGainDb: 10,
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
    const session = new WorkSession(info, dir, worker, new ActionRecorder(dir), new EventLog(join(dir, 'events.jsonl')));
    session.listen();
    session.save();
    return session;
  }

  private listen(): void {
    this.worker.onEvent((e) => {
      switch (e.type) {
        case 'level':
          this.level = e.rms;
          this.gainDb = e.gainDb;
          break;
        case 'utterance': {
          const u: Utterance = { start: e.start, end: e.end, text: e.text };
          this.utterances++;
          appendFileSync(join(this.dir, 'utterances.jsonl'), JSON.stringify(u) + '\n');
          this.utteranceEmitter.fire(u);
          break;
        }
        case 'error':
          this.failEmitter.fire(e.message);
          break;
        case 'exit':
          if (!this.stopping) this.failEmitter.fire(`音声ワーカーが終了しました（code=${e.code}）`);
          break;
      }
    });
  }

  private save(): void {
    writeFileSync(join(this.dir, 'session.json'), JSON.stringify(this.info, null, 2));
  }

  async stop(): Promise<SessionInfo> {
    this.stopping = true;
    let audio = { audioSec: 0, speechSec: 0, decodeSec: 0 };
    try {
      if (this.worker.running) audio = await this.worker.request({ type: 'stop' }, 'stopped', 60_000);
    } catch {
      // 止めるときの失敗は記録を残すことを優先して無視する
    }
    this.worker.dispose();
    await this.recorder.stop();
    this.events.dispose();
    this.info.endedAt = Date.now();
    this.info.stats = { audioSec: audio.audioSec, speechSec: audio.speechSec, decodeSec: audio.decodeSec, utterances: this.utterances, actions: this.recorder.count };
    this.save();
    this.utteranceEmitter.dispose();
    this.failEmitter.dispose();
    return this.info;
  }
}
