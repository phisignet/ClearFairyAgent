// 拡張機能が Copilot に渡す skill（記録の読み方）の確認（npm run test:unit）
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { NO_REASON } from '../../src/pipeline/steps';

// out/unit/ から見たリポジトリのルート
const root = join(__dirname, '..', '..');
const skills = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { contributes: { chatSkills: { path: string }[] } }).contributes.chatSkills;

describe('記録の読み方の skill', () => {
  const text = readFileSync(join(root, skills[0].path), 'utf8');

  it('name が親フォルダの名前と同じで、description がある', () => {
    assert.equal(text.match(/^name: (.+)$/m)?.[1], basename(dirname(skills[0].path)));
    assert.match(text, /^description: .+$/m);
  });

  it('理由が無いことを表す文言がコードと同じ', () => {
    assert.ok(text.includes(NO_REASON));
  });

  it('Obsidian に依存しない', () => {
    assert.doesNotMatch(text, /obsidian|vault/i);
  });
});
