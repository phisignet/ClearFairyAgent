import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

const isGuide = (t: vscode.Tab) => t.label === 'ClearFairy: Phase 0 の確認';
const guideTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isGuide);

describe('手順ページ', () => {
  it('統合テストの VS Code では自動で開かず、コマンドで開ける', async () => {
    const extension = vscode.extensions.getExtension('local.clearfairy-vscode');
    assert.ok(extension, '拡張機能が読み込まれていること');
    await extension.activate();
    assert.equal(guideTabs().length, 0, 'テスト中は自動で開かないこと');

    await vscode.commands.executeCommand('clearfairy.spike.openGuide');
    const end = Date.now() + 10_000;
    while (guideTabs().length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    assert.equal(guideTabs().length, 1, 'コマンドで手順ページが開くこと');
    await vscode.window.tabGroups.close(guideTabs());
  });
});
