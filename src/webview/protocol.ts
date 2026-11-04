// 画面（webview）と拡張機能の間でやり取りするメッセージ。両方から読む。
import type { AnswerVia, Inference, Question } from '../pipeline/steps';

export const INFERENCE_LABEL: Record<Inference['status'], string> = { open: '確かめていない', accepted: '合っている', revised: '直して答えた', rejected: '違う' };

export interface QuestionItem {
  key: string;
  when: string;
  where: string;
  question: string;
  status: Question['status'];
  kind: NonNullable<Question['kind']>;
  answer?: string;
  via?: AnswerVia;
  decision?: string;
  rationale?: string;
  inference?: { text: string; reasoning: string; basis: string[]; status: Inference['status'] };
  busy: boolean;
}

export interface QuestionsState {
  items: QuestionItem[];
  voiceKey?: string;
  voiceReady: boolean;
}

export type ToQuestionsPage =
  | ({ type: 'state' } & QuestionsState)
  // text はこれまでに聞き取った全文。final は聞き取りの終わり、auto は話さない時間が続いて自動で終えたとき
  | { type: 'voiceText'; key: string; text: string; final?: boolean; auto?: boolean }
  | { type: 'focus'; key: string };

export type FromQuestionsPage =
  | { type: 'ready' }
  | { type: 'voiceStop' }
  | { type: 'answer'; key: string; text: string; via: AnswerVia }
  | { type: 'open' | 'accept' | 'reject' | 'dismiss' | 'voiceStart'; key: string };

export type ToSessionPage = { type: 'content'; html: string };

export type FromSessionPage = { type: 'open'; file: string; cell?: number; line?: number };
