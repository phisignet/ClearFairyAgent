// 確認の質問の表示と回答（論文の In-Situ Questioning）。作業を止めるポップアップは出さない。
// - 質問の対象になったコード行・セルの上に「❓」（CodeLens）を出す
// - ステータスバーに未回答の数を出す
// - サイドバーの「質問」に一覧を出し、テキストか音声で答える。音声は文字起こしを入力欄に入れ、確かめてから送る
// - 過去の判断から推測した理由があれば質問に添え、「合っている」「直して答える」「違う」で確かめてもらう
// 画面の側は src/webview/questions.ts。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { where } from '../capture/targets';
import { clock, errorDetail, errorMessage, locationLabel } from '../format';
import { SavedAnswers, type AnswerTarget } from '../pipeline/answers';
import type { PipelineOptions } from '../pipeline/engine';
import type { LivePipeline } from '../pipeline/live';
import { readSessionInfo, readSteps } from '../pipeline/records';
import { pastDecisionLabel, type Anchor, type Inference, type Question, type Step, type StepSummary } from '../pipeline/steps';
import type { VoiceCapture } from '../speech/voiceAnswer';
import type { FromQuestionsPage, QuestionsState, ToQuestionsPage } from '../webview/protocol';
import { openLocation } from './sessionView';
import { webviewPage } from './webviewPage';

// 音声で答えているとき、この間なにも話さなければ聞き取りを終える（終えるのを忘れて、作業中の独り言が回答に入らないように）
const VOICE_IDLE_MS = 15_000;

export interface QuestionsDeps {
  extensionUri: vscode.Uri;
  sessionsRoot(): string;
  pipelineOptions(dir: string): PipelineOptions;
  // 記録中と、止めた後の処理が終わっていないセッション
  lives(): ReadonlyMap<string, LivePipeline>;
  // 音声で答える。記録中なら作業セッションの録音を使い、そうでなければ短い録音を始める。
  // onText には雑音（Whisper の「ご視聴ありがとうございました」など）を除いた、これまでの回答の全文を渡す
  // onError は、始めた後に録音が止まったとき（マイクから音が届かないなど）
  startVoice(onText: (text: string) => void, onError: (message: string) => void): Promise<VoiceCapture>;
  // 回答を反映したとき
  onAnswered(dir: string): void;
  log: vscode.OutputChannel;
}

interface Item {
  key: string;
  dir: string;
  stepId: string;
  startedAt: number;
  t0: number;
  question: Question;
  summary?: StepSummary;
  inference?: Inference;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// 質問の場所がこの文書か。セルは URI で探し、見つからなければノートブックのパスとセル番号で探す（開き直すと URI が変わるため）
function matches(anchor: Anchor, doc: vscode.TextDocument): boolean {
  if (anchor.uri && anchor.uri === doc.uri.toString()) return true;
  const w = where(doc);
  if (w.file !== anchor.file) return false;
  return anchor.cell === undefined ? w.cell === undefined : w.cell === anchor.cell;
}

export class QuestionsController implements vscode.Disposable, vscode.CodeLensProvider, vscode.WebviewViewProvider {
  private items: Item[] = [];
  private view: vscode.WebviewView | undefined;
  private voice: { key: string; capture?: VoiceCapture; lastText: number } | undefined;
  private voiceTimer: NodeJS.Timeout | undefined;
  private readonly busy = new Set<string>();
  private readonly saved: SavedAnswers;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: QuestionsDeps) {
    this.saved = new SavedAnswers(deps.pipelineOptions);
    this.status.command = 'clearfairy.showQuestions';
    this.subscriptions.push(this.status, this.lensEmitter);
    this.refresh();
  }

  // コードの上の表示・サイドバー・コマンドをつなぐ
  register(): this {
    this.subscriptions.push(
      vscode.languages.registerCodeLensProvider([{ language: 'python' }], this),
      vscode.window.registerWebviewViewProvider('clearfairy.questions', this, { webviewOptions: { retainContextWhenHidden: true } }),
      vscode.commands.registerCommand('clearfairy.showQuestions', () => vscode.commands.executeCommand('clearfairy.questions.focus')),
      vscode.commands.registerCommand('clearfairy.answerQuestion', async (key: string) => {
        await vscode.commands.executeCommand('clearfairy.questions.focus');
        this.post({ type: 'focus', key });
      }),
    );
    return this;
  }

  get openCount(): number {
    return this.items.filter((i) => i.question.status === 'open').length;
  }

  private post(message: ToQuestionsPage): void {
    void this.view?.webview.postMessage(message);
  }

  // 質問を集め直す。記録中のセッションはメモリ上の結果、それ以外は steps.json から
  refresh(): void {
    const items: Item[] = [];
    const lives = this.deps.lives();
    const add = (dir: string, startedAt: number, s: Pick<Step, 'id' | 't0' | 'summary' | 'question' | 'inference'>) => {
      if (s.question) items.push({ key: `${dir}::${s.id}`, dir, stepId: s.id, startedAt, t0: s.t0, question: s.question, summary: s.summary, inference: s.inference });
    };
    for (const [dir, live] of lives) for (const s of live.pipeline.steps) add(dir, live.pipeline.origin, s);
    const root = this.deps.sessionsRoot();
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (lives.has(dir)) continue;
        try {
          const stored = readSteps(dir);
          if (!stored) continue;
          const { startedAt } = readSessionInfo(dir);
          for (const s of stored.steps) add(dir, startedAt, s);
        } catch {
          // 書きかけの結果などは次の機会に読む
        }
      }
    }
    this.items = items.sort((a, b) => b.question.createdAt - a.question.createdAt);
    // 答えている質問が、答えない・取り下げなどで無くなったら、聞き取りも終える
    const voiceKey = this.voice?.key;
    if (voiceKey && !this.items.some((i) => i.key === voiceKey && i.question.status === 'open')) void this.stopVoice({ discard: true });
    this.updateStatus();
    this.lensEmitter.fire();
    this.render();
  }

  private updateStatus(): void {
    if (this.voice) {
      this.status.text = '$(mic-filled) 回答を聞いています';
      this.status.tooltip = `質問への回答として聞いています（作業の文字起こしには入れません）。${VOICE_IDLE_MS / 1000} 秒話さないと自動で終えます。クリックで一覧を開く`;
      this.status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.status.show();
      return;
    }
    const open = this.openCount;
    this.status.text = `$(comment-discussion) 質問 ${open}`;
    this.status.tooltip = `ClearFairy の確認の質問（未回答 ${open} 件）。クリックで一覧を開く`;
    this.status.backgroundColor = undefined;
    if (open > 0) this.status.show();
    else this.status.hide();
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const i of this.items) {
      const anchor = i.question.anchor;
      if (i.question.status !== 'open' || !anchor || !matches(anchor, doc)) continue;
      const line = Math.min(Math.max(0, (anchor.line ?? 1) - 1), Math.max(0, doc.lineCount - 1));
      const guessed = i.inference?.status === 'open';
      const title =
        i.question.kind === 'confirm'
          ? guessed
            ? `💡 ClearFairy: 前の説明と同じ？「${short(i.inference!.text, 40)}」`
            : '❓ ClearFairy: この判断の理由は？'
          : `❓ ClearFairy: ${short(i.question.text, 50)}${guessed ? '（💡 推測あり）' : ''}`;
      lenses.push(new vscode.CodeLens(new vscode.Range(line, 0, line, 0), { title, command: 'clearfairy.answerQuestion', arguments: [i.key] }));
    }
    return lenses;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.deps.extensionUri] };
    view.webview.html = webviewPage(
      view.webview,
      this.deps.extensionUri,
      'questions',
      '<div id="open"></div><p id="empty" class="empty" hidden>未回答の質問はありません。業務・データ固有の判断で理由が弱いとき、ここに質問が出ます（前に説明した理由で足りそうなら、推測の確認だけが出ます）。</p><div id="done"></div>',
    );
    view.webview.onDidReceiveMessage((m: FromQuestionsPage) => void this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  private render(): void {
    const state: QuestionsState = {
      items: this.items.map((i) => {
        const a = i.question.anchor;
        return {
          key: i.key,
          when: `${new Date(i.startedAt).toLocaleDateString('ja-JP')} の記録 ${clock(i.t0, i.startedAt)}`,
          where: a ? locationLabel(a.file, a.cell, a.line) : '',
          question: i.question.text,
          status: i.question.status,
          kind: i.question.kind ?? 'ask',
          answer: i.question.answer?.text,
          via: i.question.answer?.via,
          decision: i.summary?.decision_and_actions,
          rationale: i.summary?.rationale,
          inference: i.inference && { text: i.inference.text, reasoning: i.inference.reasoning, basis: i.inference.basis.map(pastDecisionLabel), status: i.inference.status },
          busy: this.busy.has(i.key),
        };
      }),
      voiceKey: this.voice?.key,
      voiceReady: !!this.voice?.capture,
    };
    this.post({ type: 'state', ...state });
  }

  private async onMessage(m: FromQuestionsPage): Promise<void> {
    if (m.type === 'ready') return this.render();
    if (m.type === 'voiceStop') return this.stopVoice();
    const item = this.items.find((i) => i.key === m.key);
    if (!item) return;
    switch (m.type) {
      case 'open':
        if (item.question.anchor) await openLocation(item.question.anchor.file, item.question.anchor.cell, item.question.anchor.line);
        break;
      case 'answer': {
        const text = m.text.trim();
        if (!text) break;
        // 聞き取りの途中で送ったら、聞き取りは終える
        if (this.voice?.key === item.key) await this.stopVoice({ discard: true });
        await this.update(item, (t) => t.answer(item.stepId, text, m.via));
        break;
      }
      case 'accept':
        await this.update(item, (t) => t.acceptInference(item.stepId));
        break;
      case 'reject':
        await this.update(item, (t) => t.rejectInference(item.stepId));
        break;
      case 'dismiss':
        await this.update(item, (t) => t.dismiss(item.stepId));
        break;
      case 'voiceStart':
        await this.startVoice(item);
        break;
    }
  }

  // 記録中のセッションへの回答は記録中の処理と順番に、それ以外は同じ記録への回答と順番に反映する
  private async update(item: Item, apply: (target: AnswerTarget) => Promise<unknown>): Promise<void> {
    this.busy.add(item.key);
    this.render();
    try {
      await apply(this.deps.lives().get(item.dir) ?? this.saved.target(item.dir));
    } catch (e) {
      this.deps.log.appendLine(`[questions] 回答を反映できなかった: ${errorDetail(e)}`);
      void vscode.window.showErrorMessage(`ClearFairy: 回答を反映できませんでした（${errorMessage(e)}）。入力した内容は残っているので、もう一度送れます`);
    } finally {
      this.busy.delete(item.key);
      this.refresh();
      this.deps.onAnswered(item.dir);
    }
  }

  private async startVoice(item: Item): Promise<void> {
    if (this.voice) await this.stopVoice();
    const voice: { key: string; capture?: VoiceCapture; lastText: number } = { key: item.key, lastText: Date.now() };
    this.voice = voice;
    this.updateStatus();
    this.render();
    try {
      const capture = await this.deps.startVoice(
        (text) => {
          voice.lastText = Date.now();
          this.post({ type: 'voiceText', key: item.key, text });
        },
        (message) => {
          if (this.voice !== voice) return;
          void this.stopVoice();
          void vscode.window.showErrorMessage(`ClearFairy: 録音が止まりました（${message}）`);
        },
      );
      if (this.voice === voice) {
        voice.capture = capture;
        voice.lastText = Date.now();
        this.voiceTimer = setInterval(() => {
          if (this.voice === voice && !capture.speaking && Date.now() - voice.lastText >= VOICE_IDLE_MS) void this.stopVoice({ auto: true });
        }, 1000);
      } else await capture.stop();
    } catch (e) {
      if (this.voice === voice) this.voice = undefined;
      this.updateStatus();
      void vscode.window.showErrorMessage(`ClearFairy: 録音を始められませんでした（${errorMessage(e)}）`);
    }
    this.render();
  }

  // 聞き取りを終え、聞き取った回答を入力欄に入れる（送るのは本人が確かめてから）。
  // discard: 質問が無くなったので入力欄には入れない / auto: 話さない時間が続いたので自動で終えた
  async stopVoice(o: { discard?: boolean; auto?: boolean } = {}): Promise<void> {
    const v = this.voice;
    this.voice = undefined;
    clearInterval(this.voiceTimer);
    this.updateStatus();
    this.render();
    if (!v?.capture) return;
    const text = await v.capture.stop();
    if (!o.discard) this.post({ type: 'voiceText', key: v.key, text, final: true, auto: o.auto });
  }

  dispose(): void {
    void this.stopVoice({ discard: true });
    for (const s of this.subscriptions) s.dispose();
  }
}
