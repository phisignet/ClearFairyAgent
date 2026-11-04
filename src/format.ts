// 文字列の組み立ての共通処理。vscode にも Node にも依存しない（画面の側からも使う）。

// 通知に出す短い説明
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ログに残す詳しい説明（スタックがあれば付ける）
export const errorDetail = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

// 記録の開始からの経過時間（mm:ss）
export const clock = (t: number, origin: number): string => {
  const s = Math.max(0, Math.round((t - origin) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export const locationLabel = (file: string, cell?: number, line?: number): string => (cell !== undefined ? `${file} のセル${cell}` : line !== undefined ? `${file}:${line}` : file);

export const escapeHtml = (s: unknown): string =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// ターミナルの色などの制御文字を除く
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
