// 発話（音声ワーカーの区間ごとの文字起こし）を文に分け、Whisper の幻聴や相づちだけの文に印を付ける。
// vscode に依存しない（単体テストで回す）。

export interface Utterance {
  start: number;
  end: number;
  text: string;
}

export interface Sentence {
  id: string;
  t0: number;
  t1: number;
  text: string;
  // 補正前の文字起こし（補正したときだけ）
  original?: string;
  // hallucination: 話していないのに Whisper が出した定型文など / filler: 相づち・言いよどみだけ
  noise?: 'hallucination' | 'filler';
}

// 無音や打鍵音の区間で Whisper が出しがちな定型文（Phase 1 の録音で確認したもの）
const HALLUCINATIONS = [
  /^ご視聴ありがとうございました/,
  /^(おわり|終わり)$/,
  /^おやすみなさい$/,
  /^おめでとうございます$/,
  /^次回予告$/,
  /^チャンネル登録/,
  /^(字幕|翻訳)/,
  /^ありがとうございました$/,
];
const FILLER = /^(ん+|うん+|はい|ふう+|ふぅ+|えっと|えーと|えー+|あー+|あ+|う+ん|うーん|ねえ|ま+|お+)$/;
// 同じ文字の 4 回以上の繰り返し（「シィィィィ」「ああああ」）
const REPEATED = /(.)\1{3,}/;

const normalizeForNoise = (s: string) => s.replace(/[。、！？!?.,，．\s…・ー〜~「」]/g, '');

export function noiseOf(text: string): Sentence['noise'] {
  const n = normalizeForNoise(text);
  if (n.length === 0 || HALLUCINATIONS.some((r) => r.test(n)) || REPEATED.test(n)) return 'hallucination';
  if (FILLER.test(n)) return 'filler';
  return undefined;
}

// 発話がまるごと雑音（幻覚・相づち）か。質問への音声の回答から除くのに使う
export const isNoiseUtterance = (text: string): boolean => toSentences([{ start: 0, end: 1, text }]).every((s) => s.noise);

// 発話を文に分ける。時刻は、発話の中の文字数の割合で配分する。記録中に少しずつ分けるときは、id の通し番号を startIndex から続ける
export function toSentences(utterances: Utterance[], startIndex = 0): Sentence[] {
  const segmenter = new Intl.Segmenter('ja', { granularity: 'sentence' });
  const out: Sentence[] = [];
  for (const u of utterances) {
    const parts = [...segmenter.segment(u.text)].map((s) => s.segment.trim()).filter(Boolean);
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let done = 0;
    for (const p of parts) {
      const t0 = u.start + ((u.end - u.start) * done) / total;
      done += p.length;
      const t1 = u.start + ((u.end - u.start) * done) / total;
      out.push({ id: `s${startIndex + out.length + 1}`, t0: Math.round(t0), t1: Math.round(t1), text: p, noise: noiseOf(p) });
    }
  }
  return out;
}
