// 記録の対象にするファイル。.py と .ipynb（セル）だけで、仮想環境やキャッシュの中は本人の作業ではないので外す。
import * as vscode from 'vscode';

const IGNORED_DIR = /[\\/](\.venv|venv|env|node_modules|site-packages|__pycache__|\.git|\.clearfairy)[\\/]/i;

export const isTargetUri = (uri: vscode.Uri): boolean =>
  uri.scheme === 'vscode-notebook-cell' || (uri.scheme === 'file' && /\.(py|ipynb)$/i.test(uri.fsPath) && !IGNORED_DIR.test(uri.fsPath));

export const isTarget = (doc: vscode.TextDocument): boolean => isTargetUri(doc.uri);

export interface Where {
  // ワークスペースからの相対パス（セルならノートブックのパス）
  file: string;
  // ノートブックのファイル自体のパス（外部からの変更の判定に使う）
  fsPath: string;
  cell?: number;
}

// ノートブックのセルなら、ノートブックとセル番号を返す
export function where(doc: vscode.TextDocument): Where {
  if (doc.uri.scheme === 'vscode-notebook-cell') {
    for (const nb of vscode.workspace.notebookDocuments) {
      const cell = nb.getCells().find((c) => c.document === doc);
      if (cell) return { file: vscode.workspace.asRelativePath(nb.uri), fsPath: nb.uri.fsPath, cell: cell.index };
    }
  }
  return { file: vscode.workspace.asRelativePath(doc.uri), fsPath: doc.uri.fsPath };
}
