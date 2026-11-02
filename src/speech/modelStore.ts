// 音声認識モデルと VAD の置き場所。無ければ sherpa-onnx の GitHub リリースから取ってきて展開する。
import { execFile } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { SPEECH_MODELS, VAD_ASSET, type SpeechModelId } from '../config';

const RELEASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';

// Windows 10 以降は bsdtar が標準で入っていて、.tar.bz2 も展開できる
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

export interface ModelPaths {
  modelDir: string;
  vadModel: string;
}

export class ModelStore {
  constructor(readonly dir: string) {}

  paths(model: SpeechModelId): ModelPaths {
    return { modelDir: join(this.dir, SPEECH_MODELS[model].asset), vadModel: join(this.dir, VAD_ASSET) };
  }

  has(model: SpeechModelId): boolean {
    const p = this.paths(model);
    return existsSync(p.modelDir) && existsSync(p.vadModel);
  }

  // 無ければ確認してからダウンロードする。取り消されたら undefined
  async ensure(model: SpeechModelId): Promise<ModelPaths | undefined> {
    if (this.has(model)) return this.paths(model);
    const { label, sizeMB } = SPEECH_MODELS[model];
    const answer = await vscode.window.showInformationMessage(
      `音声認識モデル「${label}」（約 ${sizeMB}MB）をダウンロードします。初回だけ必要です。`,
      { modal: true },
      'ダウンロードする',
    );
    if (answer !== 'ダウンロードする') return undefined;
    mkdirSync(this.dir, { recursive: true });
    const done = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `ClearFairy: ${label}`, cancellable: true },
      async (progress, token) => {
        if (!existsSync(join(this.dir, VAD_ASSET))) await this.download(VAD_ASSET, join(this.dir, VAD_ASSET), progress, token);
        const archive = join(this.dir, `${SPEECH_MODELS[model].asset}.tar.bz2`);
        await this.download(`${SPEECH_MODELS[model].asset}.tar.bz2`, archive, progress, token);
        progress.report({ message: '展開しています…' });
        await this.extract(archive, this.paths(model).modelDir);
        return !token.isCancellationRequested;
      },
    );
    return done && this.has(model) ? this.paths(model) : undefined;
  }

  private async download(asset: string, dest: string, progress: vscode.Progress<{ message?: string }>, token: vscode.CancellationToken): Promise<void> {
    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());
    const part = `${dest}.part`;
    try {
      const res = await fetch(`${RELEASE}/${asset}`, { signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`${asset} を取得できません（HTTP ${res.status}）`);
      const total = Number(res.headers.get('content-length') ?? 0);
      let received = 0;
      let lastReport = 0;
      const body = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      body.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received - lastReport > 5 * 2 ** 20) {
          lastReport = received;
          const mb = (n: number) => (n / 2 ** 20).toFixed(0);
          progress.report({ message: `${asset}: ${mb(received)}${total ? ` / ${mb(total)}` : ''} MB` });
        }
      });
      await pipeline(body, createWriteStream(part));
      renameSync(part, dest);
    } finally {
      sub.dispose();
      rmSync(part, { force: true });
    }
  }

  // 一時ディレクトリに展開してから名前を変える（途中で止まっても中途半端なモデルが残らないように）
  private async extract(archive: string, modelDir: string): Promise<void> {
    const tmp = `${modelDir}.tmp`;
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    try {
      await promisify(execFile)(TAR, ['-xjf', archive, '-C', tmp, '--strip-components=1']);
      renameSync(tmp, modelDir);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(archive, { force: true });
    }
  }
}
