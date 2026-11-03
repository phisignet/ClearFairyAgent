import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { WorkSession, type SessionInfo } from '../src/session/session';

// out/test/ から見たリポジトリのルート
const root = join(__dirname, '..', '..');
const models = join(root, '.cache', 'models');
const dir = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'test-tmp-session');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);

describe('作業セッション', () => {
  before(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    // Windows では閉じた直後のファイルが消せないことがあるので、再試行し、それでも駄目なら残す
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      // 次回の before() で消す
    }
  });

  it('録音と操作の記録を同時に始めて止め、発話・操作・概要をセッションのフォルダに残す', async () => {
    const log = vscode.window.createOutputChannel('ClearFairy (test)');
    const file = join(dir, 'work.py');
    writeFileSync(file, 'def f():\n    return 1\n');
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    // ファイルを作ったときのディスクの変更通知は遅れて届くので、外部からの書き換えと見なされないよう落ち着くまで待つ
    await sleep(2500);

    // マイクの代わりに TTS の WAV を 4 倍速で流す（認識の速い zipformer を使う）
    const session = await WorkSession.start({
      root: join(dir, 'sessions'),
      workerScript: join(root, 'dist', 'speechWorker.js'),
      model: { modelDir: join(models, 'sherpa-onnx-zipformer-ja-en-reazonspeech-2025-01-17'), vadModel: join(models, 'silero_vad.onnx') },
      speechModel: 'zipformer-ja-en',
      threads: 4,
      keepAudio: true,
      log,
      input: { recorder: 'file', wav: join(root, '.cache', 'testdata', 'tts', 'haruka-desktop.wav'), speed: 4 },
    });
    await editor.edit((b) => b.replace(new vscode.Range(1, 11, 1, 12), '2'));
    // 音声（約 87 秒）を流し終えるまで待つ
    await sleep(25_000);
    const info: SessionInfo = await session.stop();
    log.dispose();

    console.log(JSON.stringify(info, null, 1));
    assert.ok(info.endedAt && info.endedAt > info.startedAt);
    assert.ok((info.stats?.utterances ?? 0) >= 10, `発話が ${info.stats?.utterances} 件しかない`);
    assert.ok((info.stats?.actions ?? 0) >= 1, '編集が操作として残ること');
    assert.equal(lines(join(session.dir, 'utterances.jsonl')).length, info.stats?.utterances);
    assert.ok(lines(join(session.dir, 'actions.jsonl')).some((l) => JSON.parse(l).kind === 'edit'));
    assert.ok(lines(join(session.dir, 'events.jsonl')).length > 0, '生のイベントも残すこと');
    assert.ok(existsSync(join(session.dir, 'audio.wav')), '録音を残すこと');
    assert.deepEqual(JSON.parse(readFileSync(join(session.dir, 'session.json'), 'utf8')).stats, info.stats);
  });

  it('拡張機能を起動すると、記録の読み方を .clearfairy/README.md に置く', async () => {
    await vscode.extensions.getExtension('local.clearfairy-vscode')!.activate();
    const guide = join(vscode.workspace.workspaceFolders![0].uri.fsPath, '.clearfairy', 'README.md');
    assert.equal(readFileSync(guide, 'utf8'), readFileSync(join(root, 'skills', 'clearfairy-records', 'SKILL.md'), 'utf8'));
  });
});
