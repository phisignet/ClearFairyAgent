// Copilot の言語モデル API（vscode.lm）の薄いラッパー。
import * as vscode from 'vscode';

const JUSTIFICATION = 'ClearFairy は、独り言と操作の記録から意思決定ステップを作るために言語モデルを使います。';

export function copilotModels(): Thenable<vscode.LanguageModelChat[]> {
  return vscode.lm.selectChatModels({ vendor: 'copilot' });
}

export interface Completion {
  text: string;
  firstTokenMs: number;
  totalMs: number;
}

export async function complete(model: vscode.LanguageModelChat, messages: vscode.LanguageModelChatMessage[], token?: vscode.CancellationToken): Promise<Completion> {
  const started = performance.now();
  const response = await model.sendRequest(messages, { justification: JUSTIFICATION }, token);
  let text = '';
  let firstTokenMs = 0;
  for await (const chunk of response.text) {
    if (!firstTokenMs) firstTokenMs = performance.now() - started;
    text += chunk;
  }
  return { text, firstTokenMs: Math.round(firstTokenMs), totalMs: Math.round(performance.now() - started) };
}
