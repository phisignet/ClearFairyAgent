// VSCode の操作イベントを JSONL に生のまま書き出す（作業セッションの events.jsonl）。
// Phase 0 では手動の編集と AI の編集を見分ける手がかりを調べるのに使い、今は操作のまとめ方を見直すときの元データとして残す。
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import * as vscode from 'vscode';
import { isTarget, isTargetUri } from './targets';

const EXCERPT = 200;
const OUTPUT_TAIL = 2000;
const VISIBLE_RANGE_DEBOUNCE_MS = 1000;

const SELECTION_KIND: Record<number, string> = {
  [vscode.TextEditorSelectionChangeKind.Keyboard]: 'keyboard',
  [vscode.TextEditorSelectionChangeKind.Mouse]: 'mouse',
  [vscode.TextEditorSelectionChangeKind.Command]: 'command',
};

const excerpt = (s: string, n = EXCERPT) => (s.length > n ? `${s.slice(0, n)}…(${s.length}字)` : s);

export class EventLog implements vscode.Disposable {
  private readonly out: WriteStream;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly lastSelection = new Map<string, { t: number; kind: string }>();
  private readonly saving = new Set<string>();
  private readonly visibleTimers = new Map<vscode.TextEditor, NodeJS.Timeout>();
  private readonly terminalOutput = new Map<vscode.TerminalShellExecution, string>();
  private readonly lastDiagnostics = new Map<string, string>();
  count = 0;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.out = createWriteStream(file, { flags: 'a' });
    this.write('log.start', { vscode: vscode.version });
    this.listenEditors();
    this.listenNotebooks();
    this.listenFiles();
    this.listenTerminal();
    this.listenDebug();
    this.listenDiagnostics();
  }

  // 解析しやすいように、ログに目印を入れる（例: 「ここから AI に編集させる」）
  mark(label: string): void {
    this.write('mark', { label });
  }

  private write(type: string, data: Record<string, unknown> = {}): void {
    this.count++;
    this.out.write(JSON.stringify({ t: Date.now(), type, ...data }) + '\n');
  }

  private on<T>(event: vscode.Event<T>, listener: (e: T) => void): void {
    this.subscriptions.push(event(listener));
  }

  // ノートブックのセルなら「ノートブックのパス#セル番号」、それ以外はワークスペースからの相対パス
  private where(doc: vscode.TextDocument): Record<string, unknown> {
    if (doc.uri.scheme === 'vscode-notebook-cell') {
      for (const nb of vscode.workspace.notebookDocuments) {
        const cell = nb.getCells().find((c) => c.document === doc);
        if (cell) return { file: vscode.workspace.asRelativePath(nb.uri), cell: cell.index, cellKind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup' };
      }
    }
    return { file: vscode.workspace.asRelativePath(doc.uri), scheme: doc.uri.scheme };
  }

  private listenEditors(): void {
    this.on(vscode.workspace.onDidChangeTextDocument, (e) => {
      if (!isTarget(e.document) || e.contentChanges.length === 0) return;
      const key = e.document.uri.toString();
      const sel = this.lastSelection.get(key);
      const now = Date.now();
      this.write('text.change', {
        ...this.where(e.document),
        version: e.document.version,
        dirty: e.document.isDirty,
        reason: e.reason === vscode.TextDocumentChangeReason.Undo ? 'undo' : e.reason === vscode.TextDocumentChangeReason.Redo ? 'redo' : undefined,
        // 見分けの手がかり: アクティブなエディタか / ウィンドウにフォーカスがあるか / 直前の選択変更の種類と経過時間 / 保存処理中か
        active: vscode.window.activeTextEditor?.document === e.document,
        focused: vscode.window.state.focused,
        lastSelection: sel ? { kind: sel.kind, ago: now - sel.t } : undefined,
        duringSave: this.saving.has(key),
        changes: e.contentChanges.map((c) => ({
          range: [c.range.start.line, c.range.start.character, c.range.end.line, c.range.end.character],
          removed: c.rangeLength,
          inserted: c.text.length,
          lines: c.text.split('\n').length - 1,
          text: excerpt(c.text),
        })),
      });
    });

    this.on(vscode.window.onDidChangeTextEditorSelection, (e) => {
      if (!isTarget(e.textEditor.document)) return;
      const kind = e.kind === undefined ? 'unknown' : (SELECTION_KIND[e.kind] ?? String(e.kind));
      this.lastSelection.set(e.textEditor.document.uri.toString(), { t: Date.now(), kind });
      this.write('selection', { ...this.where(e.textEditor.document), kind, line: e.selections[0]?.active.line, n: e.selections.length });
    });

    this.on(vscode.window.onDidChangeTextEditorVisibleRanges, (e) => {
      if (!isTarget(e.textEditor.document)) return;
      clearTimeout(this.visibleTimers.get(e.textEditor));
      this.visibleTimers.set(
        e.textEditor,
        setTimeout(() => {
          this.visibleTimers.delete(e.textEditor);
          this.write('visible', { ...this.where(e.textEditor.document), ranges: e.visibleRanges.map((r) => [r.start.line, r.end.line]) });
        }, VISIBLE_RANGE_DEBOUNCE_MS),
      );
    });

    this.on(vscode.window.onDidChangeActiveTextEditor, (editor) => {
      if (editor && isTarget(editor.document)) this.write('editor.active', this.where(editor.document));
    });
    this.on(vscode.window.onDidChangeWindowState, (s) => this.write('window', { focused: s.focused, active: s.active }));

    this.on(vscode.workspace.onWillSaveTextDocument, (e) => {
      if (!isTarget(e.document)) return;
      this.saving.add(e.document.uri.toString());
      const reason = e.reason === vscode.TextDocumentSaveReason.Manual ? 'manual' : e.reason === vscode.TextDocumentSaveReason.AfterDelay ? 'afterDelay' : 'focusOut';
      this.write('text.willSave', { ...this.where(e.document), reason });
    });
    this.on(vscode.workspace.onDidSaveTextDocument, (doc) => {
      if (!isTarget(doc)) return;
      this.saving.delete(doc.uri.toString());
      this.write('text.save', this.where(doc));
    });
  }

  private listenNotebooks(): void {
    const outputs = (cell: vscode.NotebookCell) =>
      cell.outputs.flatMap((o) =>
        o.items.map((item) => {
          const isText = /^(text\/|application\/vnd\.code\.notebook\.(stdout|stderr|error)|application\/json)/.test(item.mime);
          const text = isText ? new TextDecoder().decode(item.data) : undefined;
          return { mime: item.mime, bytes: item.data.byteLength, text: text === undefined ? undefined : excerpt(text, 500) };
        }),
      );

    this.on(vscode.workspace.onDidChangeNotebookDocument, (e) => {
      const file = vscode.workspace.asRelativePath(e.notebook.uri);
      for (const c of e.contentChanges) {
        this.write('notebook.cells', {
          file,
          range: [c.range.start, c.range.end],
          removed: c.removedCells.length,
          added: c.addedCells.map((cell) => ({ index: cell.index, kind: cell.kind === vscode.NotebookCellKind.Code ? 'code' : 'markup', text: excerpt(cell.document.getText()) })),
          active: vscode.window.activeNotebookEditor?.notebook === e.notebook,
          focused: vscode.window.state.focused,
        });
      }
      for (const c of e.cellChanges) {
        // セルの本文の変更は text.change 側で記録するので、ここでは出力と実行結果を残す
        if (!c.outputs && !c.executionSummary && !c.metadata) continue;
        const s = c.executionSummary;
        this.write('notebook.cell', {
          file,
          cell: c.cell.index,
          outputs: c.outputs ? outputs(c.cell) : undefined,
          execution: s ? { order: s.executionOrder, success: s.success, ms: s.timing ? s.timing.endTime - s.timing.startTime : undefined } : undefined,
          metadataChanged: c.metadata ? true : undefined,
        });
      }
    });
    this.on(vscode.window.onDidChangeActiveNotebookEditor, (editor) => {
      if (editor) this.write('notebook.active', { file: vscode.workspace.asRelativePath(editor.notebook.uri) });
    });
    this.on(vscode.workspace.onDidSaveNotebookDocument, (nb) => this.write('notebook.save', { file: vscode.workspace.asRelativePath(nb.uri) }));
  }

  // ディスク上の変更（AI エージェントがファイルを直接書き換えた場合など）
  private listenFiles(): void {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{py,ipynb}');
    this.subscriptions.push(watcher);
    const file = (type: string) => (uri: vscode.Uri) => {
      if (isTargetUri(uri)) this.write(type, { file: vscode.workspace.asRelativePath(uri) });
    };
    this.on(watcher.onDidCreate, file('fs.create'));
    this.on(watcher.onDidChange, file('fs.change'));
    this.on(watcher.onDidDelete, file('fs.delete'));
  }

  private listenTerminal(): void {
    this.on(vscode.window.onDidStartTerminalShellExecution, (e) => {
      this.write('terminal.start', { terminal: e.terminal.name, command: e.execution.commandLine.value, confidence: e.execution.commandLine.confidence, cwd: e.execution.cwd?.fsPath });
      this.terminalOutput.set(e.execution, '');
      void (async () => {
        for await (const data of e.execution.read()) {
          const tail = (this.terminalOutput.get(e.execution) ?? '') + data;
          this.terminalOutput.set(e.execution, tail.slice(-OUTPUT_TAIL));
        }
      })();
    });
    this.on(vscode.window.onDidEndTerminalShellExecution, (e) => {
      const output = this.terminalOutput.get(e.execution);
      this.terminalOutput.delete(e.execution);
      // 色などの制御文字を除いて末尾だけ残す
      // eslint-disable-next-line no-control-regex
      const clean = output?.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
      this.write('terminal.end', { terminal: e.terminal.name, command: e.execution.commandLine.value, exitCode: e.exitCode, outputTail: clean ? excerpt(clean.slice(-500), 500) : undefined });
    });
  }

  private listenDebug(): void {
    // イベントの種類（type）と混ざらないよう、デバッガの種類は debugType に入れる
    this.on(vscode.debug.onDidStartDebugSession, (s) =>
      this.write('debug.start', { debugType: s.type, name: s.name, request: s.configuration.request, program: s.configuration.program, module: s.configuration.module }),
    );
    this.on(vscode.debug.onDidTerminateDebugSession, (s) => this.write('debug.end', { debugType: s.type, name: s.name }));
    this.on(vscode.debug.onDidChangeBreakpoints, (e) => {
      const loc = (b: vscode.Breakpoint) => (b instanceof vscode.SourceBreakpoint ? `${vscode.workspace.asRelativePath(b.location.uri)}:${b.location.range.start.line + 1}` : 'function');
      this.write('debug.breakpoints', { added: e.added.map(loc), removed: e.removed.map(loc), changed: e.changed.map(loc) });
    });
    this.subscriptions.push(
      vscode.debug.registerDebugAdapterTrackerFactory('*', {
        createDebugAdapterTracker: () => ({
          onDidSendMessage: (m: { type?: string; event?: string; body?: Record<string, unknown> }) => {
            if (m.type === 'event' && m.event === 'stopped') {
              this.write('debug.stopped', { reason: m.body?.reason, description: m.body?.description, text: m.body?.text });
            }
          },
        }),
      }),
    );
  }

  private listenDiagnostics(): void {
    this.on(vscode.languages.onDidChangeDiagnostics, (e) => {
      for (const uri of e.uris) {
        if (!isTargetUri(uri)) continue;
        const diags = vscode.languages.getDiagnostics(uri);
        const count = (sev: vscode.DiagnosticSeverity) => diags.filter((d) => d.severity === sev).length;
        const summary = {
          errors: count(vscode.DiagnosticSeverity.Error),
          warnings: count(vscode.DiagnosticSeverity.Warning),
          top: diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).slice(0, 3).map((d) => ({ line: d.range.start.line, source: d.source, message: excerpt(d.message, 120) })),
        };
        // Pylance は編集のたびに同じ結果を出し直すので、前回と変わったときだけ残す
        const key = JSON.stringify(summary);
        if (this.lastDiagnostics.get(uri.toString()) === key) continue;
        this.lastDiagnostics.set(uri.toString(), key);
        this.write('diagnostics', { file: vscode.workspace.asRelativePath(uri), scheme: uri.scheme, ...summary });
      }
    });
  }

  dispose(): void {
    this.write('log.stop', { events: this.count });
    for (const t of this.visibleTimers.values()) clearTimeout(t);
    for (const s of this.subscriptions) s.dispose();
    this.out.end();
  }
}
