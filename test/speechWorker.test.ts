import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { SpeechWorker } from '../src/speech/client';

// out/test/ から見たリポジトリのルート
const root = join(__dirname, '..', '..');
const models = join(root, '.cache', 'models');
const script = join(root, 'dist', 'speechWorker.js');

describe('音声ワーカー', () => {
  const log = vscode.window.createOutputChannel('ClearFairy (test)');
  after(() => log.dispose());

  it('拡張機能ホストから起動でき、Electron 上でネイティブモジュールを読み込める', async () => {
    const worker = new SpeechWorker(script, log);
    try {
      const probe = await worker.request({ type: 'probe' }, 'probe');
      console.log(JSON.stringify(probe.versions));
      assert.ok(probe.versions.electron, '拡張機能ホストと同じ Electron で動いていること');
      assert.ok(probe.sherpa.ok, probe.sherpa.error);
      assert.ok(probe.recorders.decibri.ok, probe.recorders.decibri.error);
      assert.ok(probe.recorders.pvrecorder.ok, probe.recorders.pvrecorder.error);
    } finally {
      worker.dispose();
    }
  });

  it('WAV を流し込むと、発話ごとに実時刻付きの文字起こしが返る', async () => {
    const worker = new SpeechWorker(script, log);
    const utterances: { start: number; end: number; text: string }[] = [];
    const ended = new Promise<void>((resolve) =>
      worker.onEvent((e) => {
        if (e.type === 'utterance') utterances.push(e);
        if (e.type === 'inputEnded') resolve();
      }),
    );
    try {
      const before = Date.now();
      await worker.request(
        {
          type: 'start',
          options: {
            modelDir: join(models, 'sherpa-onnx-zipformer-ja-en-reazonspeech-2025-01-17'),
            vadModel: join(models, 'silero_vad.onnx'),
            recorder: 'file',
            inputWav: join(root, '.cache', 'testdata', 'tts', 'haruka-desktop.wav'),
            speed: 4,
            numThreads: 4,
            padBefore: 0.3,
            padAfter: 0.2,
          },
        },
        'ready',
        60_000,
      );
      await ended;
      const stopped = await worker.request({ type: 'stop' }, 'stopped');
      console.log(JSON.stringify(stopped), utterances.length, '件');
      assert.ok(utterances.length >= 12, `発話が ${utterances.length} 件しかない`);
      assert.ok(utterances.every((u) => u.start >= before - 1000 && u.end > u.start), '実時刻が入っていること');
      assert.match(utterances.map((u) => u.text).join(''), /データフレーム/);
    } finally {
      worker.dispose();
    }
  });
});
