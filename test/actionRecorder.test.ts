import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { ActionRecorder } from '../src/capture/actionRecorder';
import type { Action, CellRunAction, EditAction, ViewAction } from '../src/capture/actions';
import { barChartPng } from '../src/spike/png';

// .clearfairy/ の中は記録の対象外なので、ワークスペース直下の作業用フォルダを使う（テストの後に消す）
const dir = join(vscode.workspace.workspaceFolders![0].uri.fsPath, 'test-tmp-actions');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const readActions = (sessionDir: string): Action[] =>
  readFileSync(join(sessionDir, 'actions.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const SOURCE = `def load(path):
    return open(path).read()


def summarize(rows):
    total = 0
    for r in rows:
        total += r
    return total
`;

// テストはウィンドウにフォーカスがある前提（手での編集はフォーカスのあるウィンドウでしか起きないため）
describe('操作のまとめ役（ActionRecorder）', () => {
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

  it('手での編集を関数名・差分付きでまとめ、外部からの書き換えとアクティブでない文書への編集は除く', async () => {
    const file = join(dir, 'sample.py');
    const other = join(dir, 'other.py');
    writeFileSync(file, SOURCE);
    writeFileSync(other, 'x = 1\n');
    const session = join(dir, 'session-edit');
    const otherDoc = await vscode.workspace.openTextDocument(other);
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file));
    // ファイルを作ったときのディスクの変更通知は遅れて届くので、外部からの書き換えと見なされないよう落ち着くまで待つ
    await sleep(2500);
    const recorder = new ActionRecorder(session);
    try {
      // summarize の中を 2 回に分けて編集する（3 秒以内なので 1 つにまとまるはず）
      await editor.edit((b) => b.insert(new vscode.Position(6, 0), '    # 合計を出す\n'));
      await sleep(500);
      await editor.edit((b) => b.replace(new vscode.Range(9, 11, 9, 16), 'int(total)'));
      await sleep(3500);

      // アクティブでない文書への編集（エージェントの編集に当たる）
      const edit = new vscode.WorkspaceEdit();
      edit.insert(otherDoc.uri, new vscode.Position(0, 0), 'import os\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      // 保存してから、外部プロセスとして書き換える（Claude Code と同じ方式）
      await editor.document.save();
      await sleep(500);
      writeFileSync(file, SOURCE.replace('return total', 'return round(total)'));
      const end = Date.now() + 15_000;
      while (!editor.document.getText().includes('round(total)') && Date.now() < end) await sleep(100);
      assert.ok(editor.document.getText().includes('round(total)'), '外部の書き換えが読み込まれること');
      await sleep(3500);
    } finally {
      await recorder.stop();
    }

    const edits = readActions(session).filter((a): a is EditAction => a.kind === 'edit');
    console.log(JSON.stringify(edits, null, 1));
    assert.equal(edits.length, 1, '手での編集だけが 1 つにまとまること');
    assert.equal(edits[0].file.replace(/\\/g, '/').endsWith('test-tmp-actions/sample.py'), true);
    assert.match(edits[0].diff, /\+    # 合計を出す/);
    assert.match(edits[0].diff, /\+    return int\(total\)/);
    assert.doesNotMatch(edits[0].diff, /round/, '外部の書き換えが差分に混ざらないこと');
    assert.equal(edits[0].added, 2);
    assert.equal(edits[0].removed, 1);
  });

  it('編集せずに見ていた範囲を「閲覧」として残す', async () => {
    const file = join(dir, 'view.py');
    writeFileSync(file, SOURCE);
    const session = join(dir, 'session-view');
    await vscode.window.showTextDocument(vscode.Uri.file(file));
    const recorder = new ActionRecorder(session);
    try {
      await sleep(3500);
      // 別のファイルに切り替えると、それまでの閲覧が区切られる
      await vscode.window.showTextDocument(vscode.Uri.file(join(dir, 'other.py')));
      await sleep(300);
    } finally {
      await recorder.stop();
    }
    const views = readActions(session).filter((a): a is ViewAction => a.kind === 'view');
    console.log(JSON.stringify(views));
    assert.equal(views.length, 1);
    assert.deepEqual(views[0].lines?.[0], 1);
  });

  it('セルの実行を、出力（テキスト・画像・エラー）付きで残す', async () => {
    const file = join(dir, 'sample.ipynb');
    writeFileSync(
      file,
      JSON.stringify({
        cells: [
          { cell_type: 'code', metadata: {}, source: ['by_store.plot.bar()'], execution_count: null, outputs: [] },
          { cell_type: 'code', metadata: {}, source: ['raise KeyError("amout")'], execution_count: null, outputs: [] },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    );
    const session = join(dir, 'session-nb');
    // Jupyter の代わりのテスト用カーネル
    const controller = vscode.notebooks.createNotebookController('clearfairy-test-kernel-2', 'jupyter-notebook', 'テスト用カーネル');
    controller.supportedLanguages = ['python'];
    let order = 0;
    controller.executeHandler = async (cells) => {
      for (const cell of cells) {
        const run = controller.createNotebookCellExecution(cell);
        run.executionOrder = ++order;
        run.start(Date.now());
        if (cell.document.getText().includes('raise')) {
          await run.replaceOutput(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(new Error("KeyError: 'amout'"))]));
          run.end(false, Date.now());
        } else {
          await run.replaceOutput(new vscode.NotebookCellOutput([new vscode.NotebookCellOutputItem(barChartPng(), 'image/png'), vscode.NotebookCellOutputItem.text('<Axes>')]));
          run.end(true, Date.now());
        }
      }
    };
    const recorder = new ActionRecorder(session);
    try {
      const nb = await vscode.workspace.openNotebookDocument(vscode.Uri.file(file));
      const editor = await vscode.window.showNotebookDocument(nb);
      await vscode.commands.executeCommand('notebook.selectKernel', { notebookEditor: editor, id: controller.id, extension: 'local.clearfairy-vscode' });
      await vscode.commands.executeCommand('notebook.execute', nb.uri);
      const end = Date.now() + 15_000;
      while (!nb.getCells().every((c) => c.executionSummary?.success !== undefined) && Date.now() < end) await sleep(100);
      await sleep(800);
    } finally {
      controller.dispose();
      await recorder.stop();
    }
    const runs = readActions(session).filter((a): a is CellRunAction => a.kind === 'cell-run');
    console.log(JSON.stringify(runs, null, 1));
    assert.equal(runs.length, 2, '実行ごとに 1 つ');
    const plot = runs.find((r) => r.cell === 0)!;
    assert.equal(plot.success, true);
    const image = plot.outputs.find((o) => o.image)?.image;
    assert.ok(image && existsSync(join(session, image)), '画像をセッションに保存すること');
    const error = runs.find((r) => r.cell === 1)!;
    assert.equal(error.success, false);
    assert.match(error.outputs.map((o) => o.text ?? '').join(''), /KeyError/);
  });
});
