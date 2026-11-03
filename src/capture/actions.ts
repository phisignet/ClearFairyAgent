// 作業の記録で扱う「操作」。VS Code のイベントを、意思決定ステップの材料になる単位にまとめたもの。
// 論文（ClearFairy）の action（Figma の操作ログ）と artifact（操作後のスクリーンショット）に当たり、
// コーディングでは編集の差分・実行結果・エラー表示が artifact の役をする。
// 行番号は 1 始まり、時刻はエポックミリ秒。

export interface OutputSummary {
  mime: string;
  // テキスト・エラーの抜粋
  text?: string;
  // 画像はセッションのディレクトリに保存し、その相対パスを持つ
  image?: string;
}

interface BaseAction {
  id: string;
  t0: number;
  t1: number;
  // 文書の URI（ノートブックならセルの文書）。セルを足すと番号がずれるので、場所を指すときはこちらを優先する
  uri?: string;
}

// 同じファイル（セル）への手での編集を、間が空くまで 1 つにまとめたもの
export interface EditAction extends BaseAction {
  kind: 'edit';
  file: string;
  cell?: number;
  // 変更後の行番号での範囲
  lines: [number, number];
  // 変更範囲にかかる関数・クラス
  symbols: string[];
  diff: string;
  added: number;
  removed: number;
  // 元に戻す・やり直すを含む
  undo?: boolean;
}

// 編集せずに一定時間見ていた範囲。ファイルなら行、ノートブックならセルの範囲
export interface ViewAction extends BaseAction {
  kind: 'view';
  file: string;
  lines?: [number, number];
  cells?: [number, number];
  symbols: string[];
}

export interface CellRunAction extends BaseAction {
  kind: 'cell-run';
  file: string;
  cell: number;
  order?: number;
  success?: boolean;
  source: string;
  outputs: OutputSummary[];
}

export interface TerminalAction extends BaseAction {
  kind: 'terminal';
  command: string;
  exitCode?: number;
  output: string;
}

export interface DebugAction extends BaseAction {
  kind: 'debug';
  event: 'start' | 'stopped' | 'end' | 'breakpoints';
  detail: string;
  file?: string;
  line?: number;
}

// エラー表示（Pylance・Ruff など）の件数が変わった
export interface DiagnosticsAction extends BaseAction {
  kind: 'diagnostics';
  file: string;
  cell?: number;
  errors: number;
  warnings: number;
  messages: string[];
}

export type Action = EditAction | ViewAction | CellRunAction | TerminalAction | DebugAction | DiagnosticsAction;
