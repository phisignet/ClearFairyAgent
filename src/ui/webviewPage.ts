// 画面（webview）の HTML の共通部分。CSS は media/、スクリプトは src/webview/ を束ねた dist/webview/ から読む。
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function webviewPage(webview: vscode.Webview, extensionUri: vscode.Uri, name: 'questions' | 'sessionView', body: string): string {
  const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...path));
  const nonce = randomBytes(16).toString('hex');
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('media', `${name}.css`)}">
</head>
<body>
${body}
<script nonce="${nonce}" src="${asset('dist', 'webview', `${name}.js`)}"></script>
</body>
</html>`;
}
