// 確認の質問の表示と回答（論文の In-Situ Questioning）。作業を止めるポップアップは出さない。
// - 質問の対象になったコード行・セルの上に「❓」（CodeLens）を出す
// - ステータスバーに未回答の数を出す
// - サイドバーの「質問」に一覧を出し、テキストか音声で答える。音声は文字起こしを入力欄に入れ、確かめてから送る
// - 過去の判断から推測した理由があれば質問に添え、「合っている」「直して答える」「違う」で確かめてもらう
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { where } from '../capture/targets';
import { Pipeline, type PipelineOptions } from '../pipeline/engine';
import type { LivePipeline } from '../pipeline/live';
import type { Anchor, AnswerVia, Inference, PastDecision, Question, StepSummary } from '../pipeline/steps';
import { openLocation, refreshSessionView } from './sessionView';

export interface VoiceCapture {
  stop(): Promise<string>;
  // VAD が発話の途中と見ているか（話している途中で自動で終えないため）
  readonly speaking: boolean;
}

// 音声で答えているとき、この間なにも話さなければ聞き取りを終える（終えるのを忘れて、作業中の独り言が回答に入らないように）
const VOICE_IDLE_MS = 15_000;

export interface QuestionsDeps {
  sessionsRoot(): string;
  pipelineOptions(dir: string): PipelineOptions;
  // 記録中のセッション（あれば）
  current(): { dir: string; live: LivePipeline } | undefined;
  // 音声で答える。記録中なら作業セッションの録音を使い、そうでなければ短い録音を始める。
  // onText には雑音（Whisper の「ご視聴ありがとうございました」など）を除いた、これまでの回答の全文を渡す
  // onError は、始めた後に録音が止まったとき（マイクから音が届かないなど）
  startVoice(onText: (text: string) => void, onError: (message: string) => void): Promise<VoiceCapture>;
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

interface StoredStep {
  id: string;
  t0: number;
  summary?: StepSummary;
  question?: Question;
  inference?: Inference;
}

// 回答を反映する先（記録中は LivePipeline、それ以外は保存済みの結果から読み直した Pipeline）
interface AnswerTarget {
  answer(stepId: string, text: string, via: AnswerVia): Promise<unknown>;
  acceptInference(stepId: string): Promise<unknown>;
  rejectInference(stepId: string): unknown;
  dismiss(stepId: string): unknown;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const basisLabel = (d: PastDecision) => `${d.session ? `${new Date(d.at).toLocaleDateString('ja-JP')} の記録` : 'この記録'}「${d.decision}」 → ${d.rationale}`;

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
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: QuestionsDeps) {
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
        void this.view?.webview.postMessage({ focus: key });
      }),
    );
    return this;
  }

  get openCount(): number {
    return this.items.filter((i) => i.question.status === 'open').length;
  }

  // 質問を集め直す。記録中のセッションはメモリ上の結果、それ以外は steps.json から
  refresh(): void {
    const items: Item[] = [];
    const current = this.deps.current();
    const add = (dir: string, startedAt: number, s: StoredStep) => {
      if (s.question) items.push({ key: `${dir}::${s.id}`, dir, stepId: s.id, startedAt, t0: s.t0, question: s.question, summary: s.summary, inference: s.inference });
    };
    if (current) for (const s of current.live.pipeline.steps) add(current.dir, current.live.pipeline.origin, s);
    const root = this.deps.sessionsRoot();
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const dir = join(root, name);
        if (dir === current?.dir || !existsSync(join(dir, 'steps.json'))) continue;
        try {
          const { steps } = JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8')) as { steps: StoredStep[] };
          const { startedAt } = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as { startedAt: number };
          for (const s of steps) add(dir, startedAt, s);
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
    view.webview.options = { enableScripts: true };
    view.webview.html = html();
    view.webview.onDidReceiveMessage((m: { type: string; key?: string; text?: string; via?: AnswerVia }) => void this.onMessage(m));
    view.onDidDispose(() => (this.view = undefined));
  }

  private render(): void {
    const label = (a?: Anchor) => (!a ? '' : a.cell !== undefined ? `${a.file} のセル${a.cell}` : a.line !== undefined ? `${a.file}:${a.line}` : a.file);
    const clock = (i: Item) => {
      const s = Math.max(0, Math.round((i.t0 - i.startedAt) / 1000));
      return `${new Date(i.startedAt).toLocaleDateString('ja-JP')} の記録 ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    void this.view?.webview.postMessage({
      items: this.items.map((i) => ({
        key: i.key,
        when: clock(i),
        where: label(i.question.anchor),
        question: i.question.text,
        status: i.question.status,
        kind: i.question.kind ?? 'ask',
        answer: i.question.answer?.text,
        via: i.question.answer?.via,
        decision: i.summary?.decision_and_actions,
        rationale: i.summary?.rationale,
        inference: i.inference && { text: i.inference.text, reasoning: i.inference.reasoning, basis: i.inference.basis.map(basisLabel), status: i.inference.status },
        busy: this.busy.has(i.key),
      })),
      voiceKey: this.voice?.key,
      voiceReady: !!this.voice?.capture,
    });
  }

  private async onMessage(m: { type: string; key?: string; text?: string; via?: AnswerVia }): Promise<void> {
    const item = this.items.find((i) => i.key === m.key);
    switch (m.type) {
      case 'ready':
        this.render();
        break;
      case 'open':
        if (item?.question.anchor) await openLocation(item.question.anchor.file, item.question.anchor.cell, item.question.anchor.line);
        break;
      case 'answer':
        if (item && m.text?.trim()) {
          // 聞き取りの途中で送ったら、聞き取りは終える
          if (this.voice?.key === item.key) await this.stopVoice({ discard: true });
          await this.update(item, (p) => p.answer(item.stepId, m.text!.trim(), m.via ?? 'text'));
        }
        break;
      case 'accept':
        if (item) await this.update(item, (p) => p.acceptInference(item.stepId));
        break;
      case 'reject':
        if (item) await this.update(item, (p) => p.rejectInference(item.stepId));
        break;
      case 'dismiss':
        if (item) await this.update(item, (p) => p.dismiss(item.stepId));
        break;
      case 'voiceStart':
        if (item) await this.startVoice(item);
        break;
      case 'voiceStop':
        await this.stopVoice();
        break;
    }
  }

  // 記録中のセッションへの回答は、記録中の処理と順番に反映する
  private async update(item: Item, apply: (p: AnswerTarget) => unknown): Promise<void> {
    this.busy.add(item.key);
    this.render();
    try {
      const current = this.deps.current();
      await apply(current && current.dir === item.dir ? current.live : Pipeline.load(this.deps.pipelineOptions(item.dir)));
    } catch (e) {
      this.deps.log.appendLine(`[questions] 回答を反映できなかった: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
      void vscode.window.showErrorMessage(`ClearFairy: 回答を反映できませんでした（${e instanceof Error ? e.message : e}）`);
    } finally {
      this.busy.delete(item.key);
      this.refresh();
      refreshSessionView(item.dir);
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
          void this.view?.webview.postMessage({ voiceText: { key: item.key, text } });
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
      void vscode.window.showErrorMessage(`ClearFairy: 録音を始められませんでした（${e instanceof Error ? e.message : e}）`);
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
    if (!o.discard) void this.view?.webview.postMessage({ voiceText: { key: v.key, text, final: true, auto: o.auto } });
  }

  dispose(): void {
    void this.stopVoice({ discard: true });
    for (const s of this.subscriptions) s.dispose();
  }
}

function html(): string {
  const nonce = Math.random().toString(36).slice(2);
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 4px 8px; line-height: 1.5; }
  .q { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px; margin: 8px 0; }
  .q.focus { outline: 2px solid var(--vscode-focusBorder); }
  .meta { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .question { font-weight: 600; margin: 4px 0; }
  .context { font-size: 0.9em; color: var(--vscode-descriptionForeground); margin: 2px 0; }
  textarea { width: 100%; box-sizing: border-box; min-height: 4em; font-family: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); margin-top: 6px; }
  .buttons { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  button { font: inherit; padding: 2px 10px; border: none; border-radius: 2px; cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.rec { background: var(--vscode-charts-red); color: #fff; }
  button:disabled { opacity: 0.5; cursor: default; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .empty { color: var(--vscode-descriptionForeground); }
  details summary { cursor: pointer; color: var(--vscode-descriptionForeground); margin-top: 12px; }
  .answer { margin: 4px 0; }
  .inference { border-left: 3px solid var(--vscode-charts-blue); padding: 2px 8px; margin: 6px 0; background: var(--vscode-textBlockQuote-background); }
  .inference p { margin: 2px 0; }
  .inference details summary { margin-top: 2px; font-size: 0.9em; }
</style>
</head>
<body>
<div id="open"></div>
<div id="done"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const drafts = {};
  const byVoice = {};
  const notes = {};
  let state = { items: [] };
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const INFERENCE_LABEL = { open: '確かめていない', accepted: '合っている', revised: '直して答えた', rejected: '違う' };

  // 過去の判断からの推測と、その元にした判断
  function inference(i) {
    const inf = i.inference;
    const basis = '<details><summary>元にした過去の判断（' + inf.basis.length + '）</summary>' +
      inf.basis.map((b) => '<p class="context">・' + esc(b) + '</p>').join('') +
      (inf.reasoning ? '<p class="context">推測の筋道: ' + esc(inf.reasoning) + '</p>' : '') + '</details>';
    if (i.status !== 'open') return '<div class="inference"><p class="context">💡 推測（' + INFERENCE_LABEL[inf.status] + '）: ' + esc(inf.text) + '</p>' + basis + '</div>';
    // 確認だけのときは、上の見出しで「前の説明からの推測」と言っている
    return '<div class="inference"><p>' + (i.kind === 'confirm' ? '' : '💡 過去の判断からの推測: ') + '<b>' + esc(inf.text) + '</b></p>' + basis +
      '<div class="buttons">' +
        '<button data-act="accept"' + (i.busy ? ' disabled' : '') + '>合っている</button>' +
        '<button class="secondary" data-act="revise"' + (i.busy ? ' disabled' : '') + '>直して答える</button>' +
        '<button class="secondary" data-act="reject"' + (i.busy ? ' disabled' : '') + '>違う</button>' +
      '</div></div>';
  }

  function render() {
    const open = state.items.filter((i) => i.status === 'open');
    const done = state.items.filter((i) => i.status !== 'open');
    document.getElementById('open').innerHTML = open.length
      ? open.map((i) => {
          const recording = state.voiceKey === i.key;
          const guessed = i.inference?.status === 'open';
          // 確認だけの項目は、推測が違ったら理由そのものを聞く
          const heading = i.kind !== 'confirm' ? '❓ ' + esc(i.question) : guessed ? '💡 ' + esc(i.question) : '❓ 推測は違いました。この判断の理由を教えてください';
          return '<div class="q" data-key="' + esc(i.key) + '">' +
            '<div class="meta">' + esc(i.when) + (i.where ? ' ・ <a data-act="open">' + esc(i.where) + '</a>' : '') + '</div>' +
            '<p class="question">' + heading + '</p>' +
            (i.decision ? '<p class="context">判断: ' + esc(i.decision) + '</p>' : '') +
            (i.rationale ? '<p class="context">理由: ' + esc(i.rationale) + '</p>' : '') +
            (guessed ? inference(i) : '') +
            '<textarea placeholder="' + (guessed ? '推測と違う・足りないところを書くか、🎤 で話してください' : '理由を書くか、🎤 で話してください') + '">' + esc(drafts[i.key] ?? '') + '</textarea>' +
            (notes[i.key] ? '<p class="context">' + esc(notes[i.key]) + '</p>' : '') +
            // 記録していないときは音声認識を読み込むのに 1〜2 秒かかり、その間に話した言葉は入らない
            (recording ? '<p class="context">' + (state.voiceReady ? '🔴 聞いています。話し終えたら「■ 話し終えた」を押してください。' : '⏳ 準備しています。🔴 が出てから話してください。') + '</p>' : '') +
            '<div class="buttons">' +
              '<button data-act="answer"' + (i.busy ? ' disabled' : '') + '>' + (i.busy ? '反映中…' : '送信') + '</button>' +
              (recording
                ? '<button class="rec" data-act="voiceStop"' + (state.voiceReady ? '' : ' disabled') + '>' + (state.voiceReady ? '■ 話し終えた' : '準備中…') + '</button>'
                : '<button class="secondary" data-act="voiceStart"' + (state.voiceKey ? ' disabled' : '') + '>🎤 音声で答える</button>') +
              '<button class="secondary" data-act="dismiss"' + (i.busy ? ' disabled' : '') + '>答えない</button>' +
            '</div></div>';
        }).join('')
      : '<p class="empty">未回答の質問はありません。業務・データ固有の判断で理由が弱いとき、ここに質問が出ます（前に説明した理由で足りそうなら、推測の確認だけが出ます）。</p>';
    document.getElementById('done').innerHTML = done.length
      ? '<details><summary>答えた・答えなかった質問（' + done.length + '）</summary>' +
        done.map((i) => '<div class="q"><div class="meta">' + esc(i.when) + '</div><p class="question">' + esc(i.question) + '</p>' +
          (i.status === 'answered'
            ? (i.via === 'inference' ? '<p class="answer">回答: 推測が合っていた</p>' : '<p class="answer">回答: ' + esc(i.answer) + '</p>') +
              (i.rationale ? '<p class="context">理由（回答込み）: ' + esc(i.rationale) + '</p>' : '')
            : '<p class="context">答えなかった</p>') +
          (i.inference ? inference(i) : '') + '</div>').join('') +
        '</details>'
      : '';
  }

  window.addEventListener('message', ({ data }) => {
    if (data.items) {
      state = data;
      render();
    }
    if (data.voiceText) {
      const { key, text, final, auto } = data.voiceText;
      // 最後に空で返ってきたとき（何も聞き取れなかった）は、それまでの下書きを消さない
      if (text || !final) {
        drafts[key] = text;
        byVoice[key] = true;
      }
      if (final) {
        notes[key] = auto ? '話さない時間が続いたので聞き取りを終えました。内容を確かめて送信してください。' : '';
        render();
      } else {
        const box = document.querySelector('.q[data-key="' + CSS.escape(key) + '"] textarea');
        if (box) box.value = text;
      }
    }
    if (data.focus) {
      const card = document.querySelector('.q[data-key="' + CSS.escape(data.focus) + '"]');
      if (card) {
        document.querySelectorAll('.q.focus').forEach((c) => c.classList.remove('focus'));
        card.classList.add('focus');
        card.scrollIntoView({ block: 'center' });
        card.querySelector('textarea')?.focus();
      }
    }
  });

  document.addEventListener('input', (e) => {
    const card = e.target.closest('.q[data-key]');
    if (card && e.target.matches('textarea')) drafts[card.dataset.key] = e.target.value;
  });

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    const card = e.target.closest('.q[data-key]');
    if (!b || !card || b.disabled) return;
    const key = card.dataset.key;
    const act = b.dataset.act;
    if (act === 'answer') {
      vscode.postMessage({ type: 'answer', key, text: drafts[key] ?? '', via: byVoice[key] ? 'voice' : 'text' });
      delete drafts[key];
      delete notes[key];
    } else if (act === 'revise') {
      // 推測を入力欄に入れ、直してから送ってもらう
      const item = state.items.find((i) => i.key === key);
      drafts[key] = item?.inference?.text ?? '';
      byVoice[key] = false;
      render();
      const box = document.querySelector('.q[data-key="' + CSS.escape(key) + '"] textarea');
      box?.focus();
      box?.setSelectionRange(box.value.length, box.value.length);
    } else {
      vscode.postMessage({ type: act, key });
    }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
