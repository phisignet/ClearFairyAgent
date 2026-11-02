import * as assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { EventLog } from '../src/capture/eventLog';
import { barChartPng } from '../src/spike/png';

// .clearfairy/ の中は記録の対象外なので、ワークスペース直下の作業用フォルダを使う（テストの後に消す）
const dir = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'test-tmp');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) throw new Error(`${what} を ${timeoutMs}ms 待ったが起きなかった`);
    await sleep(100);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Event = Record<string, any>;
const readEvents = (file: string): Event[] =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

// 目印ごとに、記録されたイベントを並べて出力する（手がかりの比較用）
function dump(events: Event[], show: (e: Event) => string | undefined): void {
  let label = '(開始)';
  for (const e of events) {
    if (e.type === 'mark') label = e.label;
    const line = show(e);
    if (line) console.log(`  [${label}] ${line}`);
  }
}

describe('操作ログ', () => {
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

  it('.py の編集を、編集元を見分ける手がかり付きで記録する', async () => {
    const file = join(dir, 'sample.py');
    writeFileSync(file, 'print("hello")\n');
    const uri = vscode.Uri.file(file);
    const logFile = join(dir, 'py-events.jsonl');
    const log = new EventLog(logFile);
    try {
      const editor = await vscode.window.showTextDocument(uri);
      await sleep(500);

      log.mark('type コマンド（キー入力に近い）');
      editor.selection = new vscode.Selection(1, 0, 1, 0);
      await vscode.commands.executeCommand('type', { text: 'x = 1\n' });
      await sleep(300);

      log.mark('editor.edit（拡張機能による編集）');
      await editor.edit((b) => b.insert(new vscode.Position(0, 0), '# comment\n'));
      await sleep(300);

      log.mark('WorkspaceEdit（エージェントの編集に近い）');
      const edit = new vscode.WorkspaceEdit();
      edit.insert(uri, new vscode.Position(0, 0), 'import os\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(300);

      log.mark('保存');
      await editor.document.save();
      await sleep(500);

      log.mark('外部プロセスによる書き換え（Claude Code と同じ方式）');
      writeFileSync(file, 'print("written by another process")\n');
      await waitFor(() => editor.document.getText().includes('another process'), 15_000, '外部の変更の読み込み');
      await sleep(1000);
    } finally {
      log.dispose();
    }
    await sleep(300);

    const events = readEvents(logFile);
    dump(events, (e) => {
      if (e.type === 'text.change') {
        return `text.change active=${e.active} focused=${e.focused} dirty=${e.dirty} duringSave=${e.duringSave} reason=${e.reason} lastSelection=${JSON.stringify(e.lastSelection)} changes=${e.changes.length}`;
      }
      if (e.type === 'selection') return `selection kind=${e.kind}`;
      if (e.type.startsWith('fs.') || e.type.startsWith('text.')) return e.type;
      return undefined;
    });
    assert.ok(events.filter((e) => e.type === 'text.change').length >= 4);
    assert.ok(events.some((e) => e.type === 'fs.change'), '外部の書き換えを fs.change として記録すること');
  });

  it('.ipynb のセルの追加・編集・実行と、出力（テキスト・エラー・画像）を記録する', async () => {
    const file = join(dir, 'sample.ipynb');
    writeFileSync(
      file,
      JSON.stringify({ cells: [{ cell_type: 'code', metadata: {}, source: ['x = 1'], execution_count: null, outputs: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
    );
    const logFile = join(dir, 'nb-events.jsonl');
    const log = new EventLog(logFile);

    // Jupyter の代わりのテスト用カーネル: 本文に応じてテキスト・画像・エラーを出力する
    const controller = vscode.notebooks.createNotebookController('clearfairy-test-kernel', 'jupyter-notebook', 'テスト用カーネル');
    controller.supportedLanguages = ['python'];
    let order = 0;
    controller.executeHandler = async (cells) => {
      for (const cell of cells) {
        const run = controller.createNotebookCellExecution(cell);
        run.executionOrder = ++order;
        run.start(Date.now());
        const source = cell.document.getText();
        if (source.includes('raise')) {
          await run.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error("KeyError: 'amout'"))]));
          run.end(false, Date.now());
        } else if (source.includes('plot')) {
          await run.replaceOutput(new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(barChartPng(), 'image/png'), vscode.NotebookCellOutputItem.text('<Figure size 640x480>')]));
          run.end(true, Date.now());
        } else {
          await run.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stdout('10\n')]));
          run.end(true, Date.now());
        }
      }
    };

    try {
      const nb = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
      const editor = await vscode.window.showNotebookDocument(nb);
      await vscode.commands.executeCommand('notebook.selectKernel', { notebookEditor: editor, id: controller.id, extension: 'local.clearfairy-vscode' });
      await sleep(500);

      log.mark('セルの追加');
      const insert = new vscode.WorkspaceEdit();
      insert.set(nb.uri, [
        vscode.NotebookEdit.insertCells(1, [
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'by_store.plot.bar()', 'python'),
          new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'raise KeyError("amout")', 'python'),
        ]),
      ]);
      await vscode.workspace.applyEdit(insert);
      await sleep(300);

      log.mark('セルの編集');
      const change = new vscode.WorkspaceEdit();
      change.insert(nb.cellAt(0).document.uri, new vscode.Position(0, 5), '0');
      await vscode.workspace.applyEdit(change);
      await sleep(300);

      log.mark('すべて実行');
      await vscode.commands.executeCommand('notebook.execute', nb.uri);
      await waitFor(() => nb.getCells().every((c) => c.executionSummary?.success !== undefined), 15_000, 'セルの実行');
      await sleep(500);
    } finally {
      controller.dispose();
      log.dispose();
    }
    await sleep(300);

    const events = readEvents(logFile);
    dump(events, (e) => {
      if (e.type === 'notebook.cells') return `notebook.cells added=${e.added.length} removed=${e.removed}`;
      if (e.type === 'notebook.cell') return `notebook.cell #${e.cell} execution=${JSON.stringify(e.execution)} outputs=${JSON.stringify(e.outputs?.map((o: Event) => o.mime))}`;
      if (e.type === 'text.change') return `text.change #${e.cell} active=${e.active} lastSelection=${JSON.stringify(e.lastSelection)}`;
      return undefined;
    });
    const cells = events.filter((e) => e.type === 'notebook.cell');
    assert.ok(events.some((e) => e.type === 'notebook.cells' && e.added.length === 2), 'セルの追加');
    assert.ok(events.some((e) => e.type === 'text.change' && e.cell === 0), 'セル本文の編集');
    assert.ok(cells.some((e) => e.execution?.success === true), '実行の成功');
    assert.ok(cells.some((e) => e.execution?.success === false), '実行の失敗');
    assert.ok(cells.some((e) => e.outputs?.some((o: Event) => o.mime === 'image/png')), '画像の出力');
    assert.ok(cells.some((e) => e.outputs?.some((o: Event) => o.mime === 'application/vnd.code.notebook.error' && o.text.includes('KeyError'))), 'エラーの出力');
  });
});
