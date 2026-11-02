// プロンプトは prompts/*.md に置き、{{名前}} を埋めて使う。
// 調整しやすいようにコードから分け、毎回ファイルから読む（拡張機能を読み込み直さなくても変更が効く）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export class Prompts {
  constructor(private readonly dir: string) {}

  render(name: string, values: Record<string, string>): string {
    const template = readFileSync(join(this.dir, `${name}.md`), 'utf8');
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (!(key in values)) throw new Error(`プロンプト ${name} の {{${key}}} に入れる値がない`);
      return values[key];
    });
  }
}
