// 作業の記録: VS Code のイベントから、本人が手で行った操作を「操作」（actions.ts）の単位にまとめ、
// セッションのディレクトリの actions.jsonl に書く。
// - edit: 同じファイル（セル）への手での編集を、間が空くまで 1 つにまとめ、前後の差分と触った関数名を付ける
// - view: 編集せずに同じ範囲を一定時間見ていたら、その範囲（独り言の多くはコードを読みながら出てくるため）
// - cell-run / terminal / debug / diagnostics: 実行結果やエラー表示（論文の artifact に当たる）
// AI エージェントの編集は含めない。Claude Code も Copilot のエージェントもディスク上のファイルを直接書き換え、
// VS Code がそれを読み込み直すので、アクティブでない文書への編集や、外部からの変更通知の直後の編集として届く。
import { createWriteStream, mkdirSync, writeFileSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { structuredPatch } from 'diff';
import * as vscode from 'vscode';
import type { Action, DebugAction, OutputSummary } from './actions';
import { isTarget, isTargetUri, where } from './targets';

const EDIT_IDLE_MS = 3000;
const VIEW_MIN_MS = 3000;
const EXTERNAL_WINDOW_MS = 2000;
const OWN_SAVE_WINDOW_MS = 1500;
const CELL_RUN_SETTLE_MS = 300;
// 入力の途中で一瞬だけ出る構文エラーを残さないよう、落ち着くまで待つ
const DIAGNOSTICS_DEBOUNCE_MS = 5000;
const DIFF_MAX_LINES = 120;
const TEXT_MAX = 1500;
// 仮想環境の有効化やデバッガの起動は、本人が打ったコマンドではないので除く
const NOISE_COMMAND = /Activate\.ps1|[\\/]activate(\.bat)?\b|debugpy[\\/]launcher/i;

const excerpt = (s: string, n = TEXT_MAX) => (s.length > n ? `${s.slice(0, n)}…（以下 ${s.length - n} 字略）` : s);
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
const lastLines = (s: string, n: number) => s.split(/\r?\n/).slice(-n).join('\n');

const SYMBOL_KINDS = new Set([vscode.SymbolKind.Function, vscode.SymbolKind.Method, vscode.SymbolKind.Class, vscode.SymbolKind.Constructor]);

interface Chunk {
  key: string;
  uri: vscode.Uri;
  file: string;
  cell?: number;
  t0: number;
  t1: number;
  // 最初の編集の直前と、最後の手での編集の直後の全文（途中で AI が書き換えても差分に混ざらないように）
  before?: string;
  after: string;
  undo: boolean;
  timer?: NodeJS.Timeout;
}

interface View {
  key: string;
  uri?: vscode.Uri;
  file: string;
  lines?: [number, number];
  cells?: [number, number];
  t0: number;
  edited: boolean;
}

export class ActionRecorder implements vscode.Disposable {
  private readonly out: WriteStream;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly emitter = new vscode.EventEmitter<Action>();
  readonly onAction = this.emitter.event;
  private seq = 0;
  count = 0;

  // 文書ごとの直近の全文（編集の前後の差分を取るため）
  private readonly snapshots = new Map<string, string>();
  private chunk: Chunk | undefined;
  private view: View | undefined;
  // 自分の保存と、外部からのディスク変更の時刻（fsPath ごと）
  private readonly savedAt = new Map<string, number>();
  private readonly externalAt = new Map<string, number>();
  private readonly emittedRuns = new Set<string>();
  private readonly terminalOutput = new Map<vscode.TerminalShellExecution, string>();
  private readonly diagnosticsTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastDiagnostics = new Map<string, string>();
  private stopped: { reason: string; text?: string; t: number } | undefined;
  private readonly pending = new Set<Promise<void>>();

  constructor(private readonly dir: string) {
    mkdirSync(join(dir, 'images'), { recursive: true });
    this.out = createWriteStream(join(dir, 'actions.jsonl'), { flags: 'a' });
    for (const doc of vscode.workspace.textDocuments) if (isTarget(doc)) this.snapshots.set(doc.uri.toString(), doc.getText());
    // 開始時点のエラー表示を基準にして、変わったときだけ残す
    for (const [uri] of vscode.languages.getDiagnostics()) if (isTargetUri(uri)) this.lastDiagnostics.set(uri.toString(), JSON.stringify(this.diagnosticsSummary(uri)));
    this.listenEdits();
    this.listenViews();
    this.listenNotebooks();
    this.listenFiles();
    this.listenTerminal();
    this.listenDebug();
    this.listenDiagnostics();
    this.startView();
  }

  private nextId(): string {
    return `a${++this.seq}`;
  }

  private emit(action: Action): void {
    this.count++;
    this.out.write(JSON.stringify(action) + '\n');
    this.emitter.fire(action);
  }

  // シンボルの取得など、非同期で出す操作は停止時に待てるようにしておく
  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  private on<T>(event: vscode.Event<T>, listener: (e: T) => void): void {
    this.subscriptions.push(event(listener));
  }

  // ---- 編集 ----

  private isManual(e: vscode.TextDocumentChangeEvent, fsPath: string): boolean {
    const doc = e.document;
    if (!vscode.window.state.focused) return false;
    const active =
      vscode.window.activeTextEditor?.document === doc ||
      (doc.uri.scheme === 'vscode-notebook-cell' && !!vscode.window.activeNotebookEditor?.notebook.getCells().some((c) => c.document === doc));
    if (!active) return false;
    if (e.reason !== undefined) return true; // 元に戻す・やり直す
    // isDirty は手がかりにしない。保存直後の最初の手入力でも、変更通知の時点ではまだ false のことがある
    const external = this.externalAt.get(fsPath);
    return external === undefined || Date.now() - external >= EXTERNAL_WINDOW_MS;
  }

  private listenEdits(): void {
    this.on(vscode.workspace.onDidOpenTextDocument, (doc) => {
      if (isTarget(doc) && !this.snapshots.has(doc.uri.toString())) this.snapshots.set(doc.uri.toString(), doc.getText());
    });
    this.on(vscode.workspace.onDidChangeTextDocument, (e) => {
      if (!isTarget(e.document) || e.contentChanges.length === 0) return;
      const key = e.document.uri.toString();
      const before = this.snapshots.get(key);
      const text = e.document.getText();
      this.snapshots.set(key, text);
      const w = where(e.document);
      if (!this.isManual(e, w.fsPath)) {
        // AI などの編集は操作に含めない。まとめている途中の編集は、そこで区切る
        if (this.chunk?.key === key) this.flushChunk();
        return;
      }
      if (this.view?.key === key || this.view?.file === w.file) this.view.edited = true;
      if (this.chunk && this.chunk.key !== key) this.flushChunk();
      const now = Date.now();
      if (!this.chunk) this.chunk = { key, uri: e.document.uri, file: w.file, cell: w.cell, t0: now, t1: now, before, after: text, undo: false };
      const c = this.chunk;
      c.t1 = now;
      c.after = text;
      if (e.reason !== undefined) c.undo = true;
      clearTimeout(c.timer);
      c.timer = setTimeout(() => this.flushChunk(), EDIT_IDLE_MS);
    });
  }

  private flushChunk(): void {
    const c = this.chunk;
    if (!c) return;
    this.chunk = undefined;
    clearTimeout(c.timer);
    if (c.before === c.after) return;
    const id = this.nextId();
    this.track(
      (async () => {
        const patch = structuredPatch(c.file, c.file, c.before ?? '', c.after, '', '', { context: 2 });
        if (patch.hunks.length === 0) return;
        let added = 0;
        let removed = 0;
        const lines: string[] = [];
        for (const h of patch.hunks) {
          lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
          for (const l of h.lines) {
            if (l.startsWith('+')) added++;
            else if (l.startsWith('-')) removed++;
            lines.push(l);
          }
        }
        const first = patch.hunks[0];
        const last = patch.hunks[patch.hunks.length - 1];
        const range: [number, number] = [first.newStart, Math.max(first.newStart, last.newStart + last.newLines - 1)];
        const diff = lines.length > DIFF_MAX_LINES ? [...lines.slice(0, DIFF_MAX_LINES), `…（以下 ${lines.length - DIFF_MAX_LINES} 行略）`].join('\n') : lines.join('\n');
        this.emit({
          kind: 'edit',
          id,
          t0: c.t0,
          t1: c.t1,
          file: c.file,
          uri: c.uri.toString(),
          cell: c.cell,
          lines: range,
          symbols: await this.symbolsAt(c.uri, range),
          diff: c.before === undefined ? `（変更前の内容は記録できなかった）\n${diff}` : diff,
          added,
          removed,
          undo: c.undo || undefined,
        });
      })(),
    );
  }

  // 範囲にかかる関数・クラス（Pylance などのシンボル情報から）
  private async symbolsAt(uri: vscode.Uri | undefined, [a, b]: [number, number]): Promise<string[]> {
    if (!uri) return [];
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined>('vscode.executeDocumentSymbolProvider', uri);
      if (!symbols?.length || !('children' in symbols[0])) return [];
      const names: string[] = [];
      const visit = (list: vscode.DocumentSymbol[], prefix: string) => {
        for (const s of list) {
          if (s.range.end.line + 1 < a || s.range.start.line + 1 > b) continue;
          if (SYMBOL_KINDS.has(s.kind)) names.push(prefix + s.name);
          visit(s.children, SYMBOL_KINDS.has(s.kind) ? `${prefix}${s.name}.` : prefix);
        }
      };
      visit(symbols as vscode.DocumentSymbol[], '');
      return names.slice(0, 5);
    } catch {
      return [];
    }
  }

  // ---- 閲覧 ----

  private startView(): void {
    this.endView();
    if (!vscode.window.state.focused) return;
    const nb = vscode.window.activeNotebookEditor;
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file' && isTarget(editor.document)) {
      const r = editor.visibleRanges[0];
      if (!r) return;
      const w = where(editor.document);
      this.view = { key: editor.document.uri.toString(), uri: editor.document.uri, file: w.file, lines: [r.start.line + 1, r.end.line + 1], t0: Date.now(), edited: false };
    } else if (nb && isTargetUri(nb.notebook.uri)) {
      const r = nb.visibleRanges[0];
      if (!r) return;
      this.view = { key: nb.notebook.uri.toString(), file: vscode.workspace.asRelativePath(nb.notebook.uri), cells: [r.start, Math.max(r.start, r.end - 1)], t0: Date.now(), edited: false };
    }
  }

  private endView(): void {
    const v = this.view;
    this.view = undefined;
    if (!v || v.edited || Date.now() - v.t0 < VIEW_MIN_MS) return;
    const id = this.nextId();
    const t1 = Date.now();
    this.track(
      (async () => {
        const symbols = v.lines ? await this.symbolsAt(v.uri, v.lines) : [];
        this.emit({ kind: 'view', id, t0: v.t0, t1, file: v.file, uri: v.uri?.toString(), lines: v.lines, cells: v.cells, symbols });
      })(),
    );
  }

  private listenViews(): void {
    this.on(vscode.window.onDidChangeActiveTextEditor, () => this.startView());
    this.on(vscode.window.onDidChangeActiveNotebookEditor, () => this.startView());
    this.on(vscode.window.onDidChangeWindowState, () => this.startView());
    this.on(vscode.window.onDidChangeTextEditorVisibleRanges, (e) => {
      if (e.textEditor !== vscode.window.activeTextEditor || e.textEditor.document.uri.scheme !== 'file') return;
      const r = e.visibleRanges[0];
      // カーソル移動の小さなスクロールでは区切らない
      if (r && this.view?.lines && Math.abs(r.start.line + 1 - this.view.lines[0]) < 5) return;
      this.startView();
    });
    this.on(vscode.window.onDidChangeNotebookEditorVisibleRanges, (e) => {
      if (e.notebookEditor === vscode.window.activeNotebookEditor) this.startView();
    });
  }

  // ---- ノートブック ----

  private listenNotebooks(): void {
    this.on(vscode.workspace.onDidChangeNotebookDocument, (e) => {
      for (const c of e.cellChanges) {
        const s = c.cell.executionSummary;
        if (!c.executionSummary || s?.success === undefined || s.executionOrder === undefined) continue;
        const key = `${c.cell.document.uri}#${s.executionOrder}`;
        if (this.emittedRuns.has(key)) continue;
        this.emittedRuns.add(key);
        this.flushChunk();
        const id = this.nextId();
        // 出力は実行の完了と前後して届くので、少し待ってから読む
        this.track(new Promise((resolve) => setTimeout(() => resolve(this.emitCellRun(id, e.notebook, c.cell)), CELL_RUN_SETTLE_MS)));
      }
    });
  }

  private emitCellRun(id: string, notebook: vscode.NotebookDocument, cell: vscode.NotebookCell): void {
    const s = cell.executionSummary;
    const now = Date.now();
    this.emit({
      kind: 'cell-run',
      id,
      t0: s?.timing?.startTime ?? now,
      t1: s?.timing?.endTime ?? now,
      file: vscode.workspace.asRelativePath(notebook.uri),
      cell: cell.index,
      uri: cell.document.uri.toString(),
      order: s?.executionOrder,
      success: s?.success,
      source: excerpt(cell.document.getText(), 800),
      outputs: this.outputs(id, cell),
    });
  }

  private outputs(id: string, cell: vscode.NotebookCell): OutputSummary[] {
    const result: OutputSummary[] = [];
    let n = 0;
    for (const output of cell.outputs) {
      const mimes = output.items.map((i) => i.mime);
      for (const item of output.items) {
        const text = () => new TextDecoder().decode(item.data);
        if (item.mime === 'image/png' || item.mime === 'image/jpeg') {
          const name = `${id}-${n++}.${item.mime === 'image/png' ? 'png' : 'jpg'}`;
          writeFileSync(join(this.dir, 'images', name), item.data);
          result.push({ mime: item.mime, image: `images/${name}` });
        } else if (item.mime === 'application/vnd.code.notebook.error') {
          try {
            const err = JSON.parse(text()) as { name?: string; message?: string; stack?: string };
            result.push({ mime: item.mime, text: `${err.name}: ${err.message}${err.stack ? `\n${lastLines(stripAnsi(err.stack), 8)}` : ''}` });
          } catch {
            result.push({ mime: item.mime, text: excerpt(text()) });
          }
        } else if (/^application\/vnd\.code\.notebook\.(stdout|stderr)$/.test(item.mime) || item.mime === 'text/plain') {
          result.push({ mime: item.mime, text: excerpt(stripAnsi(text())) });
        } else if (item.mime === 'text/html' && !mimes.includes('text/plain')) {
          result.push({ mime: item.mime, text: excerpt(text().replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')) });
        }
      }
    }
    return result;
  }

  // ---- ディスク上の変更（自分の保存か、AI などの外部からの書き換えか） ----

  private listenFiles(): void {
    const saved = (uri: vscode.Uri) => this.savedAt.set(uri.fsPath, Date.now());
    this.on(vscode.workspace.onDidSaveTextDocument, (doc) => saved(doc.uri));
    this.on(vscode.workspace.onDidSaveNotebookDocument, (nb) => saved(nb.uri));
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{py,ipynb}');
    this.subscriptions.push(watcher);
    this.on(watcher.onDidChange, (uri) => {
      if (!isTargetUri(uri)) return;
      const s = this.savedAt.get(uri.fsPath);
      // 保存の直後の 1 回は自分の保存によるもの
      if (s !== undefined && Date.now() - s < OWN_SAVE_WINDOW_MS) this.savedAt.delete(uri.fsPath);
      else this.externalAt.set(uri.fsPath, Date.now());
    });
  }

  // ---- ターミナル ----

  private listenTerminal(): void {
    this.on(vscode.window.onDidStartTerminalShellExecution, (e) => {
      if (NOISE_COMMAND.test(e.execution.commandLine.value)) return;
      this.flushChunk();
      this.terminalOutput.set(e.execution, '');
      void (async () => {
        for await (const data of e.execution.read()) {
          const out = (this.terminalOutput.get(e.execution) ?? '') + data;
          this.terminalOutput.set(e.execution, out.slice(-8000));
        }
      })();
    });
    this.on(vscode.window.onDidEndTerminalShellExecution, (e) => {
      const output = this.terminalOutput.get(e.execution);
      if (output === undefined) return;
      this.terminalOutput.delete(e.execution);
      const now = Date.now();
      this.emit({ kind: 'terminal', id: this.nextId(), t0: now, t1: now, command: e.execution.commandLine.value, exitCode: e.exitCode, output: excerpt(lastLines(stripAnsi(output), 30)) });
    });
  }

  // ---- デバッグ ----

  private debug(event: DebugAction['event'], detail: string, file?: string, line?: number): void {
    const now = Date.now();
    this.emit({ kind: 'debug', id: this.nextId(), t0: now, t1: now, event, detail, file, line });
  }

  private listenDebug(): void {
    this.on(vscode.debug.onDidStartDebugSession, (s) => {
      this.flushChunk();
      const target = s.configuration.program ?? s.configuration.module ?? '';
      this.debug('start', `${s.name}${target ? `（${vscode.workspace.asRelativePath(target)}）` : ''}`);
    });
    this.on(vscode.debug.onDidTerminateDebugSession, (s) => this.debug('end', s.name));
    this.on(vscode.debug.onDidChangeBreakpoints, (e) => {
      const loc = (b: vscode.Breakpoint) => (b instanceof vscode.SourceBreakpoint ? `${vscode.workspace.asRelativePath(b.location.uri)}:${b.location.range.start.line + 1}` : '関数');
      const parts = [e.added.length ? `追加 ${e.added.map(loc).join(', ')}` : '', e.removed.length ? `削除 ${e.removed.map(loc).join(', ')}` : ''].filter(Boolean);
      if (parts.length) this.debug('breakpoints', parts.join(' / '));
    });
    // 止まった場所は、停止イベントのあとに VS Code が要求するスタックトレースの先頭から取る
    type Message = { type?: string; event?: string; command?: string; body?: { reason?: string; text?: string; description?: string; stackFrames?: { name: string; line: number; source?: { path?: string } }[] } };
    this.subscriptions.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: () => ({
          onDidSendMessage: (m: Message) => {
            if (m.type === 'event' && m.event === 'stopped') {
              this.stopped = { reason: m.body?.reason ?? '', text: m.body?.text ?? m.body?.description, t: Date.now() };
            } else if (m.type === 'response' && m.command === 'stackTrace' && this.stopped) {
              const top = m.body?.stackFrames?.[0];
              const { reason, text } = this.stopped;
              this.stopped = undefined;
              const file = top?.source?.path ? vscode.workspace.asRelativePath(top.source.path) : undefined;
              this.debug('stopped', `${reason}${text ? `: ${text}` : ''}${top ? `（${top.name}）` : ''}`, file, top?.line);
            }
          },
        }),
      }),
    );
  }

  // ---- エラー表示 ----

  private diagnosticsSummary(uri: vscode.Uri): { errors: number; warnings: number; messages: string[] } {
    const diags = vscode.languages.getDiagnostics(uri);
    // セル実行のエラー（Jupyter が出すもの）は cell-run の側に残るので重ねない
    const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error && d.source !== 'Cell Execution Error');
    return {
      errors: errors.length,
      warnings: diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length,
      messages: errors.slice(0, 3).map((d) => `${d.range.start.line + 1}行目: ${excerpt(d.message, 160)}${d.source ? `（${d.source}）` : ''}`),
    };
  }

  private listenDiagnostics(): void {
    // Pylance は編集のたびに結果を出し直すので、落ち着いてから、変わったときだけ残す
    this.on(vscode.languages.onDidChangeDiagnostics, (e) => {
      for (const uri of e.uris) {
        if (!isTargetUri(uri)) continue;
        const key = uri.toString();
        clearTimeout(this.diagnosticsTimers.get(key));
        this.diagnosticsTimers.set(
          key,
          setTimeout(() => {
            this.diagnosticsTimers.delete(key);
            const summary = this.diagnosticsSummary(uri);
            const signature = JSON.stringify(summary);
            if (this.lastDiagnostics.get(key) === signature) return;
            const first = !this.lastDiagnostics.has(key);
            this.lastDiagnostics.set(key, signature);
            if (first && summary.errors === 0) return;
            const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
            const w = doc ? where(doc) : { file: vscode.workspace.asRelativePath(uri), cell: undefined };
            const now = Date.now();
            this.emit({ kind: 'diagnostics', id: this.nextId(), t0: now, t1: now, file: w.file, cell: w.cell, ...summary });
          }, DIAGNOSTICS_DEBOUNCE_MS),
        );
      }
    });
  }

  // まとめている途中の編集・閲覧を出し切ってから閉じる
  async stop(): Promise<void> {
    this.flushChunk();
    this.endView();
    for (const t of this.diagnosticsTimers.values()) clearTimeout(t);
    for (const s of this.subscriptions) s.dispose();
    this.subscriptions.length = 0;
    await Promise.all([...this.pending]);
    await new Promise<void>((resolve) => this.out.end(resolve));
    this.emitter.dispose();
  }

  dispose(): void {
    void this.stop();
  }
}
