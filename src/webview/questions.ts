// 確認の質問の一覧（サイドバーの画面）。拡張機能の側は src/ui/questions.ts。
import { escapeHtml as esc } from '../format';
import { INFERENCE_LABEL, type FromQuestionsPage, type QuestionItem, type QuestionsState, type ToQuestionsPage } from './protocol';

declare function acquireVsCodeApi(): { postMessage(message: FromQuestionsPage): void };

const vscode = acquireVsCodeApi();
const drafts: Record<string, string> = {};
const byVoice: Record<string, boolean> = {};
// 音声で聞き取った全文（入力欄には、この続きだけを足す）
const heard: Record<string, string> = {};
const notes: Record<string, string> = {};
let state: QuestionsState = { items: [], voiceReady: false };

const openBox = document.getElementById('open')!;
const emptyNote = document.getElementById('empty')!;
const doneBox = document.getElementById('done')!;

const cardOf = (key: string) => openBox.querySelector<HTMLElement>(`.q[data-key="${CSS.escape(key)}"]`);
const inputOf = (card: Element) => card.querySelector('textarea')!;

// 過去の判断からの推測と、その元にした判断
function inference(i: QuestionItem): string {
  const inf = i.inference!;
  const basis =
    `<details><summary>元にした過去の判断（${inf.basis.length}）</summary>` +
    inf.basis.map((b) => `<p class="context">・${esc(b)}</p>`).join('') +
    (inf.reasoning ? `<p class="context">推測の筋道: ${esc(inf.reasoning)}</p>` : '') +
    '</details>';
  if (i.status !== 'open') return `<div class="inference"><p class="context">💡 推測（${INFERENCE_LABEL[inf.status]}）: ${esc(inf.text)}</p>${basis}</div>`;
  const disabled = i.busy ? ' disabled' : '';
  // 確認だけのときは、上の見出しで「前の説明からの推測」と言っている
  return (
    `<div class="inference"><p>${i.kind === 'confirm' ? '' : '💡 過去の判断からの推測: '}<b>${esc(inf.text)}</b></p>${basis}` +
    '<div class="buttons">' +
    `<button data-act="accept"${disabled}>合っている</button>` +
    `<button class="secondary" data-act="revise"${disabled}>直して答える</button>` +
    `<button class="secondary" data-act="reject"${disabled}>違う</button>` +
    '</div></div>'
  );
}

// 未回答の質問のカード。入力欄の中身はここに含めない（入力中に作り直さないよう、中身が変わってもカードの HTML は変えない）
function card(i: QuestionItem): string {
  const recording = state.voiceKey === i.key;
  const guessed = i.inference?.status === 'open';
  // 確認だけの項目は、推測が違ったら理由そのものを聞く
  const heading = i.kind !== 'confirm' ? `❓ ${esc(i.question)}` : guessed ? `💡 ${esc(i.question)}` : '❓ 推測は違いました。この判断の理由を教えてください';
  const disabled = i.busy ? ' disabled' : '';
  return (
    `<div class="q" data-key="${esc(i.key)}">` +
    `<div class="meta">${esc(i.when)}${i.where ? ` ・ <a data-act="open">${esc(i.where)}</a>` : ''}</div>` +
    `<p class="question">${heading}</p>` +
    (i.decision ? `<p class="context">判断: ${esc(i.decision)}</p>` : '') +
    (i.rationale ? `<p class="context">理由: ${esc(i.rationale)}</p>` : '') +
    (guessed ? inference(i) : '') +
    `<textarea placeholder="${guessed ? '推測と違う・足りないところを書くか、🎤 で話してください' : '理由を書くか、🎤 で話してください'}"></textarea>` +
    (notes[i.key] ? `<p class="context">${esc(notes[i.key])}</p>` : '') +
    // 記録していないときは音声認識を読み込むのに 1〜2 秒かかり、その間に話した言葉は入らない
    (recording ? `<p class="context">${state.voiceReady ? '🔴 聞いています。話し終えたら「■ 話し終えた」を押してください。' : '⏳ 準備しています。🔴 が出てから話してください。'}</p>` : '') +
    '<div class="buttons">' +
    `<button data-act="answer"${disabled}>${i.busy ? '反映中…' : '送信'}</button>` +
    (recording
      ? `<button class="rec" data-act="voiceStop"${state.voiceReady ? '' : ' disabled'}>${state.voiceReady ? '■ 話し終えた' : '準備中…'}</button>`
      : `<button class="secondary" data-act="voiceStart"${state.voiceKey ? ' disabled' : ''}>🎤 音声で答える</button>`) +
    `<button class="secondary" data-act="dismiss"${disabled}>答えない</button>` +
    '</div></div>'
  );
}

const rendered = new WeakMap<Element, string>();

function createCard(html: string, item: QuestionItem, old: HTMLElement | undefined): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html;
  const el = template.content.firstElementChild as HTMLElement;
  rendered.set(el, html);
  inputOf(el).value = drafts[item.key] ?? '';
  if (old?.classList.contains('focus')) el.classList.add('focus');
  return el;
}

// 記録中は区切りの処理が終わるたびに一覧が届く。入力中のフォーカスや日本語の変換を切らないよう、変わったカードだけ作り直す
function renderOpen(items: QuestionItem[]): void {
  const keys = new Set(items.map((i) => i.key));
  const current = new Map<string, HTMLElement>();
  for (const el of [...openBox.children] as HTMLElement[]) {
    if (keys.has(el.dataset.key!)) current.set(el.dataset.key!, el);
    else el.remove();
  }
  let cursor = openBox.firstElementChild;
  for (const item of items) {
    const html = card(item);
    const old = current.get(item.key);
    if (old && rendered.get(old) === html) {
      if (old === cursor) cursor = cursor.nextElementSibling;
      else openBox.insertBefore(old, cursor);
      continue;
    }
    const el = createCard(html, item, old);
    openBox.insertBefore(el, old ?? cursor);
    if (old) {
      const box = inputOf(old);
      const focused = document.activeElement === box;
      const { selectionStart, selectionEnd } = box;
      if (old === cursor) cursor = old.nextElementSibling;
      old.remove();
      if (focused) {
        inputOf(el).focus();
        inputOf(el).setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }
  emptyNote.hidden = items.length > 0;
}

let lastDone = '';

function renderDone(items: QuestionItem[]): void {
  const html = items.length
    ? `<details><summary>答えた・答えなかった質問（${items.length}）</summary>` +
      items
        .map(
          (i) =>
            `<div class="q"><div class="meta">${esc(i.when)}</div><p class="question">${esc(i.question)}</p>` +
            (i.status === 'answered'
              ? (i.via === 'inference' ? '<p class="answer">回答: 推測が合っていた</p>' : `<p class="answer">回答: ${esc(i.answer)}</p>`) +
                (i.rationale ? `<p class="context">理由（回答込み）: ${esc(i.rationale)}</p>` : '')
              : '<p class="context">答えなかった</p>') +
            (i.inference ? inference(i) : '') +
            '</div>',
        )
        .join('') +
      '</details>'
    : '';
  if (html === lastDone) return;
  lastDone = html;
  const wasOpen = doneBox.querySelector('details')?.open;
  doneBox.innerHTML = html;
  const details = doneBox.querySelector('details');
  if (details && wasOpen) details.open = true;
}

function render(): void {
  // 答え終わった質問の下書きは捨てる（送信に失敗したら、未回答のままなので下書きは残る）
  for (const i of state.items) {
    if (i.status !== 'open') {
      delete drafts[i.key];
      delete notes[i.key];
    }
  }
  renderOpen(state.items.filter((i) => i.status === 'open'));
  renderDone(state.items.filter((i) => i.status !== 'open'));
}

window.addEventListener('message', ({ data }: MessageEvent<ToQuestionsPage>) => {
  if (data.type === 'state') {
    state = data;
    render();
  }
  if (data.type === 'voiceText') {
    const { key, text, final, auto } = data;
    // 届くのはこれまでに聞き取った全文。聞き取りの途中で手で直した分（聞き違いの修正など）を消さないよう、
    // 前に届いた分の続きだけを入力欄の末尾に足す
    const prev = heard[key] ?? '';
    const add = text.startsWith(prev) ? text.slice(prev.length) : text;
    if (add) {
      heard[key] = text;
      byVoice[key] = true;
      const el = cardOf(key);
      if (el) {
        const box = inputOf(el);
        box.setRangeText(add, box.value.length, box.value.length, 'preserve');
        drafts[key] = box.value;
      } else drafts[key] = (drafts[key] ?? '') + add;
    }
    if (final) {
      delete heard[key];
      notes[key] = auto ? '話さない時間が続いたので聞き取りを終えました。内容を確かめて送信してください。' : '';
      render();
    }
  }
  if (data.type === 'focus') {
    const el = cardOf(data.key);
    if (el) {
      document.querySelectorAll('.q.focus').forEach((c) => c.classList.remove('focus'));
      el.classList.add('focus');
      el.scrollIntoView({ block: 'center' });
      inputOf(el).focus();
    }
  }
});

document.addEventListener('input', (e) => {
  const target = e.target as HTMLElement;
  const el = target.closest<HTMLElement>('.q[data-key]');
  if (el && target instanceof HTMLTextAreaElement) drafts[el.dataset.key!] = target.value;
});

document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const b = target.closest<HTMLElement>('[data-act]');
  const el = target.closest<HTMLElement>('.q[data-key]');
  if (!b || !el || (b as HTMLButtonElement).disabled) return;
  const key = el.dataset.key!;
  const act = b.dataset.act!;
  if (act === 'answer') {
    vscode.postMessage({ type: 'answer', key, text: drafts[key] ?? '', via: byVoice[key] ? 'voice' : 'text' });
  } else if (act === 'revise') {
    // 推測を入力欄に入れ、直してから送ってもらう
    const box = inputOf(el);
    box.value = drafts[key] = state.items.find((i) => i.key === key)?.inference?.text ?? '';
    byVoice[key] = false;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  } else if (act === 'voiceStop') {
    vscode.postMessage({ type: 'voiceStop' });
  } else {
    // 新しく聞き取りを始めたら、届く全文は空から始まる
    if (act === 'voiceStart') delete heard[key];
    vscode.postMessage({ type: act as 'open' | 'accept' | 'reject' | 'dismiss' | 'voiceStart', key });
  }
});

vscode.postMessage({ type: 'ready' });
