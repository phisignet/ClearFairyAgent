// Phase 0 の検証用コマンド。本実装（Phase 1 以降）で置き換える。
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { EventLog } from '../capture/eventLog';
import { complete, copilotModels } from '../llm/copilot';
import { SpeechWorker } from '../speech/client';
import type { RecorderKind, StartOptions } from '../speech/protocol';
import { MARKS, openGuide } from './guide';
import { barChartPng } from './png';

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const clock = (t: number) => new Date(t).toLocaleTimeString('ja-JP', { hour12: false });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 本人の声での比較で最も正確だったモデル（手順ページからはこれで録る）
export const DEFAULT_MODEL = 'sherpa-onnx-whisper-turbo';
// pvrecorder はマイクの機器名まで返す（decibri は「マイク」としか返さない）ので、表示が分かりやすい
export const DEFAULT_RECORDER: RecorderKind = 'pvrecorder';

// 論文の「理由の質」の分類を、コーディングの独り言で試す
const RATIONALE_PROMPT = `次の発話は、Python のコーディング中の独り言です。判断の理由の質を、次の分類で評価してください。
- S-SR: 状況に即した具体的な理由がある / W-SR: 状況の説明が表面的
- S-PK: 経験・知識・原則に基づく理由がある / W-PK: 根拠のない好み
- S-CA: 代替案を比べたうえで選んでいる / W-CA: 代替案に触れるが判断基準がない
- E: 理由がほぼない
当てはまるものをすべて選び、JSON {"categories": [...], "reason": "日本語で1文"} だけを出力してください。

発話:「このループ遅いな。numpy の where でベクトル化しよう。前に同じような処理で10倍くらい速くなったから。」`;

export class Spike implements vscode.Disposable {
  readonly log = vscode.window.createOutputChannel('ClearFairy (Phase 0)');
  private readonly recordStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
  private readonly logStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly modelsDir: string;
  private readonly workerScript: string;
  private recording: { worker: SpeechWorker; started: number; level: number; gainDb: number; timer: NodeJS.Timeout } | undefined;
  private eventLog: EventLog | undefined;
  // 直近の録音で使ったマイク（手順ページに表示する）
  device: string | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.modelsDir = context.asAbsolutePath(join('.cache', 'models'));
    this.workerScript = context.asAbsolutePath(join('dist', 'speechWorker.js'));
  }

  get isRecording(): boolean {
    return this.recording !== undefined;
  }

  get isLogging(): boolean {
    return this.eventLog !== undefined;
  }

  // 作業レベルの記録はワークスペースの .clearfairy/ に置き、中の .gitignore で git から外す
  private dir(...sub: string[]): string {
    const root = join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.globalStorageUri.fsPath, '.clearfairy');
    mkdirSync(join(root, 'spike', ...sub), { recursive: true });
    if (!existsSync(join(root, '.gitignore'))) writeFileSync(join(root, '.gitignore'), '*\n');
    return join(root, 'spike', ...sub);
  }

  // ---- 環境の確認 ----

  async environment(): Promise<boolean> {
    this.log.show(true);
    this.log.appendLine('環境を確認しています…');
    const info: Record<string, unknown> = {
      vscode: vscode.version,
      platform: `${process.platform}-${process.arch}`,
      extensionHost: { node: process.versions.node, electron: process.versions.electron, napi: process.versions.napi, execPath: process.execPath },
    };
    const worker = new SpeechWorker(this.workerScript, this.log);
    try {
      info.speechWorker = await worker.request({ type: 'probe' }, 'probe');
    } catch (e) {
      info.speechWorker = { error: errorText(e) };
    } finally {
      worker.dispose();
    }
    try {
      info.copilotModels = (await copilotModels()).map((m) => ({ id: m.id, name: m.name, family: m.family, version: m.version, maxInputTokens: m.maxInputTokens }));
    } catch (e) {
      info.copilotModels = { error: errorText(e) };
    }
    const file = join(this.dir(), `environment-${stamp()}.json`);
    writeFileSync(file, JSON.stringify(info, null, 2));
    this.log.appendLine(JSON.stringify(info, null, 2));
    this.log.appendLine(`→ ${file}`);
    return true;
  }

  // ---- 録音して文字起こし ----

  private showRecording(): void {
    if (!this.recording) return;
    const sec = Math.floor((Date.now() - this.recording.started) / 1000);
    // 音量（dB）をざっくり 8 段階で表示して、マイクが音を拾えているか分かるようにする
    const db = 20 * Math.log10(Math.max(this.recording.level, 1e-6));
    const meter = '▁▂▃▄▅▆▇█'[Math.max(0, Math.min(7, Math.round(((db + 60) / 50) * 7)))];
    this.recordStatus.text = `$(record) 録音中 ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} ${meter}`;
    this.recordStatus.tooltip = `クリックで録音を止める（増幅 +${this.recording.gainDb}dB）`;
    this.recordStatus.command = 'clearfairy.spike.recordAndTranscribe';
    this.recordStatus.show();
  }

  private endRecording(): void {
    if (!this.recording) return;
    clearInterval(this.recording.timer);
    this.recording.worker.dispose();
    this.recording = undefined;
    this.recordStatus.hide();
    this.changed.fire();
  }

  // コマンドパレットから: モデルと録音ライブラリを選んで録る（録音中なら止める）
  async pickAndRecord(): Promise<void> {
    if (this.recording) return this.stopRecording();
    const models = existsSync(this.modelsDir)
      ? readdirSync(this.modelsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && d.name.startsWith('sherpa-onnx-') && !d.name.endsWith('.tmp'))
          .map((d) => d.name)
      : [];
    if (models.length === 0) {
      void vscode.window.showErrorMessage(`音声認識モデルが見つかりません: ${this.modelsDir}（scripts/download-models.sh で取得してください）`);
      return;
    }
    const model = await vscode.window.showQuickPick(models, { placeHolder: '音声認識モデルを選ぶ' });
    if (!model) return;
    const recorder = (await vscode.window.showQuickPick(['decibri', 'pvrecorder'], { placeHolder: '録音ライブラリを選ぶ' })) as RecorderKind | undefined;
    if (!recorder) return;
    await this.startRecording('manual', model, recorder);
  }

  async startRecording(name: string, model = DEFAULT_MODEL, recorder = DEFAULT_RECORDER): Promise<boolean> {
    if (this.recording) return false;
    const wav = join(this.dir('recordings'), `${name}-${stamp()}.wav`);
    const transcript = join(dirname(wav), `${basename(wav, '.wav')}.jsonl`);
    const options: StartOptions = {
      modelDir: join(this.modelsDir, model),
      vadModel: join(this.modelsDir, 'silero_vad.onnx'),
      recorder,
      numThreads: 4,
      // 声が小さいと VAD の区間の開始が最大 0.7 秒ほど遅れたので、余白を 1 秒取り、音量も自動で上げる
      padBefore: 1.0,
      padAfter: 0.2,
      autoGain: true,
      initialGainDb: 10,
      saveWav: wav,
    };
    const worker = new SpeechWorker(this.workerScript, this.log);
    worker.onEvent((e) => {
      switch (e.type) {
        case 'level':
          if (this.recording) {
            this.recording.level = e.rms;
            this.recording.gainDb = e.gainDb;
          }
          break;
        case 'utterance':
          this.log.appendLine(`[${clock(e.start)}] ${e.text}（${((e.end - e.start) / 1000).toFixed(1)}秒、認識 ${e.decodeMs}ms）`);
          appendFileSync(transcript, JSON.stringify(e) + '\n');
          break;
        case 'error':
          this.log.appendLine(`エラー: ${e.message}`);
          break;
        case 'exit':
          if (this.recording?.worker === worker) {
            this.log.appendLine(`音声ワーカーが終了しました（code=${e.code}）`);
            this.endRecording();
          }
          break;
      }
    });

    this.log.show(true);
    this.log.appendLine(`録音を始めます: ${model} / ${recorder}`);
    try {
      const ready = await worker.request({ type: 'start', options }, 'ready', 60_000);
      this.device = ready.device;
      this.log.appendLine(`準備完了: ${ready.modelKind}（読み込み ${ready.loadMs}ms）、マイク: ${ready.device}`);
      this.log.appendLine('話してください。止めるときはステータスバーの「録音中」をクリックします。');
    } catch (e) {
      this.log.appendLine(`開始に失敗: ${errorText(e)}`);
      void vscode.window.showErrorMessage(`録音を始められませんでした: ${errorText(e)}`);
      worker.dispose();
      return false;
    }
    this.recording = { worker, started: Date.now(), level: 0, gainDb: options.initialGainDb ?? 0, timer: setInterval(() => this.showRecording(), 250) };
    this.showRecording();
    this.changed.fire();
    return true;
  }

  async stopRecording(): Promise<void> {
    if (!this.recording) return;
    try {
      const s = await this.recording.worker.request({ type: 'stop' }, 'stopped');
      this.log.appendLine(`停止しました: 録音 ${s.audioSec}秒 / 発話 ${s.speechSec}秒 / 認識にかかった時間 ${s.decodeSec}秒`);
      if (s.wav) this.log.appendLine(`→ ${s.wav}`);
    } catch (e) {
      this.log.appendLine(`停止に失敗: ${errorText(e)}`);
    }
    this.endRecording();
  }

  // ---- 操作ログ ----

  startEventLog(name = 'events'): void {
    if (this.eventLog) return;
    this.eventLog = new EventLog(join(this.dir(), `${name}-${stamp()}.jsonl`));
    this.logStatus.text = '$(eye) 操作ログ記録中';
    this.logStatus.tooltip = `クリックで止める（${this.eventLog.file}）`;
    this.logStatus.command = 'clearfairy.spike.toggleEventLog';
    this.logStatus.show();
    this.changed.fire();
  }

  stopEventLog(): void {
    if (!this.eventLog) return;
    const { file, count } = this.eventLog;
    this.eventLog.dispose();
    this.eventLog = undefined;
    this.logStatus.hide();
    this.log.appendLine(`操作ログを止めました（${count} 件）: ${file}`);
    this.changed.fire();
  }

  toggleEventLog(): void {
    if (this.eventLog) this.stopEventLog();
    else this.startEventLog();
  }

  mark(label: string): void {
    if (!this.eventLog) return;
    this.eventLog.mark(label);
    this.logStatus.text = `$(eye) 操作ログ記録中: ${label}`;
  }

  async pickMark(): Promise<void> {
    if (!this.eventLog) {
      void vscode.window.showWarningMessage('操作ログを記録していません。先に「操作ログの記録を開始／停止する」を実行してください。');
      return;
    }
    const picked = await vscode.window.showQuickPick([...MARKS, 'その他（自分で入力）'], { placeHolder: 'これから何をしますか' });
    const label = picked === 'その他（自分で入力）' ? await vscode.window.showInputBox({ prompt: '目印の名前' }) : picked;
    if (label) this.mark(label);
  }

  // ---- Copilot の言語モデル ----

  // 試せたら true（モデルが無い・選択を取り消したときは false）
  async languageModel(): Promise<boolean> {
    const models = await copilotModels();
    if (models.length === 0) {
      void vscode.window.showErrorMessage('Copilot の言語モデルが見つかりません。Copilot にサインインしているか確認してください。');
      return false;
    }
    const pick = await vscode.window.showQuickPick(
      models.map((m) => ({ label: m.name, description: `${m.family}（${m.id}）`, detail: `最大入力 ${m.maxInputTokens} トークン`, model: m })),
      { placeHolder: '試すモデルを選ぶ（どれでも構いません。迷ったら一番上）' },
    );
    if (!pick) return false;
    const m = pick.model;
    const png = barChartPng();
    const pngFile = join(this.dir(), 'bar-chart.png');
    writeFileSync(pngFile, png);

    const tests: [string, vscode.LanguageModelChatMessage[]][] = [
      ['テキスト', [vscode.LanguageModelChatMessage.User('pandas で groupby の後に apply ではなく agg を使う利点を、日本語の1文で答えてください。')]],
      [
        '画像（赤・緑・青の棒。緑が最も高い）',
        [
          vscode.LanguageModelChatMessage.User([
            new vscode.LanguageModelTextPart('この画像の棒グラフについて、棒の本数と最も高い棒の色を JSON {"bars": 本数, "tallest": "色の英語名"} だけで答えてください。'),
            vscode.LanguageModelDataPart.image(png, 'image/png'),
          ]),
        ],
      ],
      ['理由の質の分類（期待: S-SR と S-PK）', [vscode.LanguageModelChatMessage.User(RATIONALE_PROMPT)]],
    ];

    this.log.show(true);
    this.log.appendLine(`モデル: ${m.name}（${m.family} / ${m.id}）`);
    const results: Record<string, unknown>[] = [];
    for (const [name, messages] of tests) {
      try {
        const r = await complete(m, messages);
        this.log.appendLine(`■ ${name}: 最初の応答 ${r.firstTokenMs}ms / 全体 ${r.totalMs}ms\n${r.text}`);
        results.push({ name, ...r });
      } catch (e) {
        this.log.appendLine(`■ ${name}: 失敗 ${errorText(e)}`);
        results.push({ name, error: errorText(e) });
      }
    }
    const file = join(this.dir(), `lm-${stamp()}.json`);
    writeFileSync(file, JSON.stringify({ model: { id: m.id, name: m.name, family: m.family, version: m.version }, results }, null, 2));
    this.log.appendLine(`→ ${file}（画像: ${pngFile}）`);
    return true;
  }

  dispose(): void {
    this.endRecording();
    this.stopEventLog();
    this.recordStatus.dispose();
    this.logStatus.dispose();
    this.changed.dispose();
    this.log.dispose();
  }
}

export function registerSpikeCommands(context: vscode.ExtensionContext): void {
  const spike = new Spike(context);
  context.subscriptions.push(
    spike,
    vscode.commands.registerCommand('clearfairy.spike.openGuide', () => openGuide(context, spike)),
    vscode.commands.registerCommand('clearfairy.spike.environment', () => spike.environment()),
    vscode.commands.registerCommand('clearfairy.spike.recordAndTranscribe', () => spike.pickAndRecord()),
    vscode.commands.registerCommand('clearfairy.spike.toggleEventLog', () => spike.toggleEventLog()),
    vscode.commands.registerCommand('clearfairy.spike.markEventLog', () => spike.pickMark()),
    vscode.commands.registerCommand('clearfairy.spike.languageModel', () => spike.languageModel()),
  );
}
