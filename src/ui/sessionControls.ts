// 作業の記録の開始・停止。ステータスバーのボタンとコマンドから使う。
import { join } from 'node:path';
import * as vscode from 'vscode';
import { SPEECH_MODELS, settings } from '../config';
import { sessionsRoot, WorkSession, type SessionInfo } from '../session/session';
import { ModelStore, type ModelPaths } from '../speech/modelStore';

export class SessionController implements vscode.Disposable {
  private session: WorkSession | undefined;
  private starting = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  // 記録を始めたとき（記録中の処理をつなぐ）
  private readonly startedEmitter = new vscode.EventEmitter<WorkSession>();
  readonly onDidStart = this.startedEmitter.event;
  // 記録を止めたとき（後段の処理に渡す）
  private readonly stoppedEmitter = new vscode.EventEmitter<{ info: SessionInfo; dir: string }>();
  readonly onDidStop = this.stoppedEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.OutputChannel,
  ) {
    this.status.command = 'clearfairy.toggleSession';
    this.render();
    this.status.show();
  }

  get current(): WorkSession | undefined {
    return this.session;
  }

  get busy(): boolean {
    return this.starting || this.session !== undefined;
  }

  private modelStore(): ModelStore {
    const dir = settings().modelsDir || join(this.context.globalStorageUri.fsPath, 'models');
    return new ModelStore(dir);
  }

  // 音声認識モデルの場所（無ければダウンロードを聞く）。記録していないときに音声で答えるのに使う
  speechModel(): Promise<ModelPaths | undefined> {
    return this.modelStore().ensure(settings().speechModel);
  }

  async toggle(): Promise<void> {
    if (this.session) await this.stop();
    else await this.start();
  }

  async start(): Promise<void> {
    if (this.busy) return;
    this.starting = true;
    this.render();
    try {
      const s = settings();
      const model = await this.modelStore().ensure(s.speechModel);
      if (!model) return;
      this.session = await WorkSession.start({
        root: sessionsRoot(this.context),
        workerScript: this.context.asAbsolutePath(join('dist', 'speechWorker.js')),
        model,
        speechModel: s.speechModel,
        threads: s.threads,
        keepAudio: s.keepAudio,
        log: this.log,
      });
      this.session.onFail((message) => {
        this.log.appendLine(`録音のエラー: ${message}`);
        void vscode.window.showErrorMessage(`ClearFairy: 録音が止まりました（${message}）。操作の記録も止めます。`);
        void this.stop();
      });
      this.log.appendLine(`記録を始めました: ${this.session.dir}（${SPEECH_MODELS[s.speechModel].label}、マイク: ${this.session.info.device}）`);
      this.timer = setInterval(() => this.render(), 500);
      this.startedEmitter.fire(this.session);
    } catch (e) {
      void vscode.window.showErrorMessage(`ClearFairy: 記録を始められませんでした（${e instanceof Error ? e.message : e}）`);
    } finally {
      this.starting = false;
      this.render();
      this.changed.fire();
    }
  }

  async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = undefined;
    clearInterval(this.timer);
    this.status.text = '$(loading~spin) 記録を保存しています…';
    const info = await session.stop();
    this.render();
    this.changed.fire();
    const s = info.stats;
    this.log.appendLine(`記録を止めました: ${session.dir}（発話 ${s?.utterances} 件 / 操作 ${s?.actions} 件 / 録音 ${s?.audioSec} 秒）`);
    void vscode.window.showInformationMessage(`ClearFairy: 記録を保存しました（発話 ${s?.utterances} 件・操作 ${s?.actions} 件）`);
    this.stoppedEmitter.fire({ info, dir: session.dir });
  }

  private render(): void {
    const s = this.session;
    if (this.starting) {
      this.status.text = '$(loading~spin) ClearFairy: 準備しています…';
      this.status.tooltip = '音声認識モデルを読み込んでいます';
      return;
    }
    if (!s) {
      this.status.text = '$(mic) ClearFairy';
      this.status.tooltip = 'クリックで作業の記録（独り言と操作）を始める';
      this.status.backgroundColor = undefined;
      return;
    }
    const sec = Math.floor((Date.now() - s.info.startedAt) / 1000);
    // 音量（dB）をざっくり 8 段階で表示して、マイクが声を拾えているか分かるようにする
    const db = 20 * Math.log10(Math.max(s.level, 1e-6)) + s.gainDb;
    const meter = '▁▂▃▄▅▆▇█'[Math.max(0, Math.min(7, Math.round(((db + 60) / 50) * 7)))];
    this.status.text = `$(record) 記録中 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} ${meter}`;
    this.status.tooltip = `クリックで記録を止める\nマイク: ${s.info.device}（増幅 +${s.gainDb}dB）\n発話 ${s.utterances} 件 / 操作 ${s.actions} 件`;
    this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  dispose(): void {
    clearInterval(this.timer);
    if (this.session) void this.session.stop();
    this.status.dispose();
    this.changed.dispose();
    this.startedEmitter.dispose();
    this.stoppedEmitter.dispose();
  }
}
