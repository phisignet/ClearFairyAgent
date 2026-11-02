// 拡張機能側から音声ワーカー（子プロセス）を起動し、メッセージをやり取りする。
import { fork, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import type { FromWorker, ToWorker, WorkerEvent } from './protocol';

export class SpeechWorker implements vscode.Disposable {
  private child: ChildProcess | undefined;
  private readonly emitter = new vscode.EventEmitter<WorkerEvent>();
  readonly onEvent = this.emitter.event;

  constructor(
    private readonly script: string,
    private readonly log: vscode.OutputChannel,
  ) {}

  get running(): boolean {
    return this.child !== undefined;
  }

  send(msg: ToWorker): void {
    if (!this.child) this.spawn();
    this.child!.send(msg);
  }

  // 指定した種類の返事（またはエラー・終了）を待つ
  request<T extends FromWorker['type']>(msg: ToWorker, type: T, timeoutMs = 30_000): Promise<Extract<FromWorker, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(() => reject(new Error(`音声ワーカーが ${timeoutMs}ms 以内に ${type} を返さなかった`))), timeoutMs);
      const sub = this.onEvent((e) => {
        if (e.type === type) done(() => resolve(e as Extract<FromWorker, { type: T }>));
        else if (e.type === 'error') done(() => reject(new Error(e.message)));
        else if (e.type === 'exit') done(() => reject(new Error(`音声ワーカーが終了した（code=${e.code}, signal=${e.signal}）`)));
      });
      const done = (f: () => void) => {
        clearTimeout(timer);
        sub.dispose();
        f();
      };
      this.send(msg);
    });
  }

  private spawn(): void {
    // 拡張機能ホストの実行ファイル（Electron）を Node として動かす。
    // execArgv はデバッグ用のフラグなどを引き継がないよう空にする
    const child = fork(this.script, [], {
      execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.stdout?.on('data', (d) => this.log.append(String(d)));
    child.stderr?.on('data', (d) => this.log.append(String(d)));
    child.on('message', (m) => this.emitter.fire(m as FromWorker));
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.emitter.fire({ type: 'exit', code, signal });
    });
    this.child = child;
  }

  dispose(): void {
    this.child?.kill();
    this.emitter.dispose();
  }
}
