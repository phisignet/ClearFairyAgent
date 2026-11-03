// 拡張機能（親）と音声ワーカー（子プロセス）の間でやり取りするメッセージ。

// file はマイクの代わりに WAV を流し込む（試験や、録音を後から処理し直すため）
export type RecorderKind = 'decibri' | 'pvrecorder' | 'file';

export interface StartOptions {
  modelDir: string;
  vadModel: string;
  recorder: RecorderKind;
  // recorder が file のときの入力と再生速度（1 が実時間）
  inputWav?: string;
  speed?: number;
  numThreads: number;
  hotwords?: string;
  // VAD の区間の前後に足す余白（秒）。語頭・語尾の欠けを防ぐ
  padBefore: number;
  padAfter: number;
  // 声の大きさに合わせて、VAD と認識に渡す前に増幅する（initialGainDb は声がたまるまでの初期値）
  autoGain?: boolean;
  initialGainDb?: number;
  // 指定すると録音を WAV で保存する（検証用）
  saveWav?: string;
}

export type ToWorker = { type: 'probe' } | { type: 'start'; options: StartOptions } | { type: 'stop' };

export interface ProbeResult {
  type: 'probe';
  versions: Record<string, string | undefined>;
  sherpa: { ok: boolean; error?: string };
  recorders: Record<Exclude<RecorderKind, 'file'>, { ok: boolean; devices?: string[]; error?: string }>;
}

export type FromWorker =
  | ProbeResult
  | { type: 'ready'; modelKind: string; loadMs: number; device: string }
  // rms は増幅前の音量（マイクが音を拾えているかの確認用）、gainDb はそのときの増幅量
  // speaking: VAD が発話の途中と見ているか（話し終わった言葉が文字になるのを待つため）
  | { type: 'level'; rms: number; gainDb: number; speaking: boolean }
  // start / end は実時刻（エポックミリ秒）。操作ログと突き合わせるため
  | { type: 'utterance'; start: number; end: number; text: string; decodeMs: number }
  // recorder が file のとき、流し込みが終わった
  | { type: 'inputEnded' }
  | { type: 'stopped'; audioSec: number; speechSec: number; decodeSec: number; lostSec?: number; wav?: string }
  | { type: 'error'; message: string };

// 親側でだけ発生するイベント
export type WorkerEvent = FromWorker | { type: 'exit'; code: number | null; signal: string | null };
