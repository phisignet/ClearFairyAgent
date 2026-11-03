import * as assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Question } from '../src/pipeline/steps';
import { QuestionsController } from '../src/ui/questions';

const workspace = vscode.workspace.workspaceFolders![0].uri;

describe('確認の質問', () => {
  const root = mkdtempSync(join(tmpdir(), 'clearfairy-questions-'));
  let controller: QuestionsController;

  before(() => {
    const dir = join(root, '20260101-000000');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.json'), JSON.stringify({ id: '20260101-000000', startedAt: 0, speechModel: 'zipformer-ja-en' }));
    const q = (id: string, status: Question['status'], anchor: Question['anchor']): Question => ({ id, text: `質問 ${id}`, status, createdAt: 1, anchor });
    const step = (id: string, question: Question) => ({ id, t0: 0, t1: 1, kind: 'linked', sentences: [], actionGroups: [], question });
    writeFileSync(
      join(dir, 'steps.json'),
      JSON.stringify({
        version: 3,
        steps: [
          step('st1', q('q1', 'open', { file: 'analysis.py', line: 3 })),
          // セルの URI が分からなくても、ノートブックのパスとセル番号で探す
          step('st2', q('q2', 'open', { file: 'explore.ipynb', uri: 'vscode-notebook-cell:/gone#X', cell: 1 })),
          step('st3', q('q3', 'dismissed', { file: 'analysis.py', line: 5 })),
        ],
      }),
    );
    controller = new QuestionsController({
      sessionsRoot: () => root,
      pipelineOptions: () => {
        throw new Error('使わない');
      },
      current: () => undefined,
      startVoice: () => Promise.reject(new Error('使わない')),
      log: vscode.window.createOutputChannel('ClearFairy (test)'),
    });
  });

  after(async () => {
    controller.dispose();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    rmSync(root, { recursive: true, force: true });
  });

  it('未回答の質問だけを数え、その場所のコード行の上に出す', async () => {
    assert.equal(controller.openCount, 2);
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(workspace, 'analysis.py'));
    const lenses = controller.provideCodeLenses(doc);
    assert.equal(lenses.length, 1);
    assert.equal(lenses[0].range.start.line, 2);
    assert.equal(lenses[0].command?.title, '❓ ClearFairy: 質問 q1');
    assert.equal(lenses[0].command?.command, 'clearfairy.answerQuestion');
  });

  it('ノートブックではセルの上に出す', async () => {
    const nb = await vscode.workspace.openNotebookDocument(vscode.Uri.joinPath(workspace, 'explore.ipynb'));
    const hits = nb.getCells().map((c) => controller.provideCodeLenses(c.document).length);
    assert.deepEqual(
      hits.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0),
      [1],
    );
  });
});
