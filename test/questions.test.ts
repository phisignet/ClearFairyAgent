import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Inference, Question } from '../src/pipeline/steps';
import { QuestionsController } from '../src/ui/questions';

// 質問を出す場所にする .py とノートブック（このテストで作って消す）
const files = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, 'test-tmp-questions');
const cell = (source: string) => ({ cell_type: 'code', source: [source], metadata: {}, outputs: [], execution_count: null });

describe('確認の質問', () => {
  const root = mkdtempSync(join(tmpdir(), 'clearfairy-questions-'));
  let controller: QuestionsController;

  before(() => {
    mkdirSync(files.fsPath, { recursive: true });
    writeFileSync(join(files.fsPath, 'analysis.py'), 'import polars as pl\n\n\ndef load(path):\n    return pl.read_csv(path)\n');
    writeFileSync(
      join(files.fsPath, 'explore.ipynb'),
      JSON.stringify({ cells: [cell('import polars as pl'), cell('df = pl.read_csv("sales.csv")')], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
    );
    const dir = join(root, '20260101-000000');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ id: '20260101-000000', startedAt: 0, speechModel: 'zipformer-ja-en' }));
    const q = (id: string, status: Question['status'], anchor: Question['anchor']): Question => ({ id, text: `質問 ${id}`, status, createdAt: 1, anchor });
    const step = (id: string, question: Question, inference?: Inference) => ({ id, t0: 0, t1: 1, kind: 'linked', sentences: [], actionGroups: [], question, inference });
    const inference: Inference = { text: '返品は売上に数えないため', reasoning: '', basis: [], status: 'open', at: 1 };
    writeFileSync(
      join(dir, 'steps.json'),
      JSON.stringify({
        version: 3,
        steps: [
          step('st1', q('q1', 'open', { file: 'test-tmp-questions/analysis.py', line: 3 })),
          // セルの URI が分からなくても、ノートブックのパスとセル番号で探す
          step('st2', q('q2', 'open', { file: 'test-tmp-questions/explore.ipynb', uri: 'vscode-notebook-cell:/gone#X', cell: 1 }), inference),
          step('st3', q('q3', 'dismissed', { file: 'test-tmp-questions/analysis.py', line: 5 })),
        ],
      }),
    );
    controller = new QuestionsController({
      extensionUri: vscode.workspace.workspaceFolders![0].uri,
      sessionsRoot: () => root,
      pipelineOptions: () => {
        throw new Error('使わない');
      },
      lives: () => new Map(),
      startVoice: () => Promise.reject(new Error('使わない')),
      onAnswered: () => {},
      log: vscode.window.createOutputChannel('ClearFairy (test)'),
    });
  });

  after(async () => {
    controller.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    rmSync(root, { recursive: true, force: true });
    rmSync(files.fsPath, { recursive: true, force: true });
  });

  it('未回答の質問だけを数え、その場所のコード行の上に出す', async () => {
    assert.equal(controller.openCount, 2);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(files, 'analysis.py'));
    const lenses = controller.provideCodeLenses(doc);
    assert.equal(lenses.length, 1);
    assert.equal(lenses[0].range.start.line, 2);
    assert.equal(lenses[0].command?.title, '❓ ClearFairy: 質問 q1');
    assert.equal(lenses[0].command?.command, 'clearfairy.answerQuestion');
  });

  it('ノートブックではセルの上に出し、過去の判断からの推測があればそう示す', async () => {
    const nb = await vscode.workspace.openNotebookDocument(vscode.Uri.joinPath(files, 'explore.ipynb'));
    const lenses = nb.getCells().map((c) => controller.provideCodeLenses(c.document));
    assert.deepEqual(
      lenses.map((l, i) => (l.length > 0 ? i : -1)).filter((i) => i >= 0),
      [1],
    );
    assert.equal(lenses[1][0].command?.title, '❓ ClearFairy: 質問 q2（💡 推測あり）');
  });
});
