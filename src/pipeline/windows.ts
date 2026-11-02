// 長いセッションを、LLM に一度に渡せる大きさの窓に分ける。vscode に依存しない。
// 論文は文 20・操作 20 を超えたら区切ってリアルタイムに処理していた。後から一括で処理するときも同じくらいの大きさにする。
// 窓の境目は、上限に近づいたところの、文も操作も無い一番長い間（ま）にする。
import type { Action } from '../capture/actions';
import type { Sentence } from './sentences';

export interface Window {
  t0: number;
  t1: number;
  sentences: Sentence[];
  actions: Action[];
}

export interface WindowLimits {
  maxSentences: number;
  maxActions: number;
}

type Item = { t: number; sentence?: Sentence; action?: Action };

export function splitWindows(sentences: Sentence[], actions: Action[], limits: WindowLimits = { maxSentences: 25, maxActions: 40 }): Window[] {
  const items: Item[] = [...sentences.map((s) => ({ t: s.t0, sentence: s })), ...actions.map((a) => ({ t: a.t0, action: a }))].sort((a, b) => a.t - b.t);
  const windows: Window[] = [];
  let start = 0;
  while (start < items.length) {
    // 上限に達する位置を探す
    let end = start;
    let s = 0;
    let a = 0;
    while (end < items.length) {
      if (items[end].sentence) s++;
      else a++;
      if (s > limits.maxSentences || a > limits.maxActions) break;
      end++;
    }
    if (end < items.length) {
      // 後ろ 3 割の中で一番長い間で切る
      const from = Math.max(start + 1, start + Math.floor((end - start) * 0.7));
      let cut = end;
      let gap = -1;
      for (let i = from; i < end; i++) {
        const g = items[i].t - items[i - 1].t;
        if (g > gap) {
          gap = g;
          cut = i;
        }
      }
      end = cut;
    }
    const part = items.slice(start, end);
    windows.push({
      t0: part[0].t,
      t1: part[part.length - 1].t,
      sentences: part.flatMap((i) => (i.sentence ? [i.sentence] : [])),
      actions: part.flatMap((i) => (i.action ? [i.action] : [])),
    });
    start = end;
  }
  return windows;
}
