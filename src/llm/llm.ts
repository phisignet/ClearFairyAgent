// Copilot の言語モデル（vscode.lm）を、モデルの選択と JSON の取り出しまで含めて使うための層。
import * as vscode from 'vscode';
import { errorMessage } from '../format';

const JUSTIFICATION = 'ClearFairy は、独り言と操作の記録から意思決定ステップを作るために言語モデルを使います。';
// 応答が返らないと、記録の処理全体が止まってしまうので打ち切る
const TIMEOUT_MS = 120_000;

export type Part = string | { image: Uint8Array; mime: string };

export interface Message {
  role: 'user' | 'assistant';
  content: string | Part[];
}

export interface TextResult {
  text: string;
  model: string;
  ms: number;
}

export function copilotModels(): Thenable<vscode.LanguageModelChat[]> {
  return vscode.lm.selectChatModels({ vendor: 'copilot' });
}

function toChat(messages: Message[]): vscode.LanguageModelChatMessage[] {
  return messages.map((m) => {
    const parts = (typeof m.content === 'string' ? [m.content] : m.content).map((p) =>
      typeof p === 'string' ? new vscode.LanguageModelTextPart(p) : vscode.LanguageModelDataPart.image(p.image, p.mime),
    );
    return m.role === 'user' ? vscode.LanguageModelChatMessage.User(parts) : vscode.LanguageModelChatMessage.Assistant(parts);
  });
}

// コードブロックや前後の説明文に囲まれていても、最初の JSON を取り出す
function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  const end = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error(`JSON が見つからない: ${text.slice(0, 200)}`);
  return JSON.parse(body.slice(start, end + 1));
}

export class Llm {
  // preferred はモデルの id か family（設定 clearfairy.llm.model）
  constructor(private readonly preferred: () => string) {}

  private async model(): Promise<vscode.LanguageModelChat> {
    const all = await copilotModels();
    if (all.length === 0) throw new Error('Copilot の言語モデルが見つかりません。Copilot にサインインしているか確認してください。');
    const want = this.preferred();
    return all.find((m) => m.id === want) ?? all.find((m) => m.family === want) ?? all[0];
  }

  async text(messages: Message[]): Promise<TextResult> {
    const model = await this.model();
    const started = performance.now();
    const cancel = new vscode.CancellationTokenSource();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancel.cancel();
        reject(new Error(`言語モデルが ${TIMEOUT_MS / 1000} 秒以内に応答しなかった`));
      }, TIMEOUT_MS);
    });
    const read = async () => {
      const response = await model.sendRequest(toChat(messages), { justification: JUSTIFICATION }, cancel.token);
      let text = '';
      for await (const chunk of response.text) text += chunk;
      return text;
    };
    try {
      const text = await Promise.race([read(), timeout]);
      return { text, model: model.id, ms: Math.round(performance.now() - started) };
    } finally {
      clearTimeout(timer);
      cancel.dispose();
    }
  }

  // JSON で答えさせる。壊れていたら、エラーを添えて 1 回だけ直させる
  async json<T>(messages: Message[]): Promise<{ value: T; raw: TextResult }> {
    const first = await this.text(messages);
    try {
      return { value: extractJson(first.text) as T, raw: first };
    } catch (e) {
      const retry = await this.text([
        ...messages,
        { role: 'assistant', content: first.text },
        { role: 'user', content: `JSON として読めませんでした（${errorMessage(e)}）。指定の形式の JSON だけを出力し直してください。` },
      ]);
      return { value: extractJson(retry.text) as T, raw: retry };
    }
  }
}
