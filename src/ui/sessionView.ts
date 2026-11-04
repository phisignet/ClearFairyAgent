// 記録したセッションの意思決定ステップを、時系列のカードで見る画面。
// カードには判断・理由・経緯と、元の発話（補正前の文も）・操作（差分・実行結果・グラフ画像）を載せ、
// セルや行をクリックするとその場所を開く。
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Action } from '../capture/actions';
import { clock, escapeHtml as esc, locationLabel } from '../format';
import { changedLines } from '../pipeline/actionGroups';
import { readActions, readSessionInfo, readSteps, type StoredStep } from '../pipeline/records';
import { NO_REASON, pastDecisionLabel, type Inference, type Question, type Task } from '../pipeline/steps';
import { INFERENCE_LABEL, type FromSessionPage, type ToSessionPage } from '../webview/protocol';
import { webviewPage } from './webviewPage';

const KIND_LABEL = { linked: '発話＋操作', talk: '発話だけ', 'action-only': '操作だけ' };
const LEVEL_LABEL = { strong: '理由: 十分', weak: '理由: 弱い', empty: '理由: 無い' };

const dateLabel = (t: number) => new Date(t).toLocaleString('ja-JP', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export async function openLocation(file: string, cell?: number, line?: number): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) return;
  const uri = vscode.Uri.joinPath(folder.uri, file);
  if (file.endsWith('.ipynb')) {
    const nb = await vscode.workspace.openNotebookDocument(uri);
    const index = Math.min(cell ?? 0, Math.max(0, nb.cellCount - 1));
    await vscode.window.showNotebookDocument(nb, { selections: [new vscode.NotebookRange(index, index + 1)], viewColumn: vscode.ViewColumn.Beside });
  } else {
    const position = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(uri, { selection: new vscode.Range(position, position), viewColumn: vscode.ViewColumn.Beside });
  }
}

export class SessionViews {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  open(dir: string): void {
    const existing = this.panels.get(dir);
    if (existing) {
      this.refresh(dir);
      existing.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel('clearfairy.session', `ClearFairy: ${dateLabel(readSessionInfo(dir).startedAt)} の記録`, vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(dir), this.extensionUri],
    });
    this.panels.set(dir, panel);
    panel.onDidDispose(() => this.panels.delete(dir));
    panel.webview.onDidReceiveMessage((m: FromSessionPage) => {
      if (m.type === 'open') void openLocation(m.file, m.cell, m.line);
    });
    panel.webview.html = this.page(panel.webview, dir);
  }

  // 開いている記録の画面を更新する（回答を反映したときなど）。見えている間は中身だけ差し替え、スクロールの位置を保つ
  refresh(dir: string): void {
    const panel = this.panels.get(dir);
    if (!panel) return;
    if (panel.visible) void panel.webview.postMessage({ type: 'content', html: content(panel.webview, dir) } satisfies ToSessionPage);
    else panel.webview.html = this.page(panel.webview, dir);
  }

  private page(webview: vscode.Webview, dir: string): string {
    return webviewPage(webview, this.extensionUri, 'sessionView', `<div id="content">${content(webview, dir)}</div>`);
  }
}

function content(webview: vscode.Webview, dir: string): string {
  const info = readSessionInfo(dir);
  const stored = readSteps(dir);
  const steps = stored?.steps ?? [];
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const actions = new Map(readActions(dir).map((a) => [a.id, a]));
  const at = (t: number) => clock(t, info.startedAt);
  const minutes = info.endedAt ? Math.round((info.endedAt - info.startedAt) / 60000) : 0;

  const link = (file: string, cell?: number, line?: number, label = locationLabel(file, cell, line)) => `<a href="#" data-open="${esc(JSON.stringify({ file, cell, line }))}">${esc(label)}</a>`;
  const diff = (text: string) => `<pre class="diff">${changedLines(text).map((l) => `<span class="${l.startsWith('+') ? 'add' : 'del'}">${esc(l)}</span>`).join('\n')}</pre>`;

  const action = (a: Action): string => {
    const time = `<span class="t">${at(a.t0)}</span>`;
    switch (a.kind) {
      case 'edit':
        return `${time} ${link(a.file, a.cell, a.lines[0])}${a.symbols.length ? `（${esc(a.symbols.join(', '))}）` : ''} を編集${diff(a.diff)}`;
      case 'cell-run': {
        const outputs = a.outputs
          .map((o) => (o.image ? `<img src="${webview.asWebviewUri(vscode.Uri.file(join(dir, o.image)))}" alt="セルの出力">` : o.text ? `<pre class="out">${esc(o.text.split('\n').slice(0, 12).join('\n'))}</pre>` : ''))
          .join('');
        return `${time} ${link(a.file, a.cell)} を実行 → <span class="${a.success === false ? 'ng' : 'ok'}">${a.success === false ? '失敗' : '成功'}</span>${outputs}`;
      }
      case 'view':
        return `${time} ${link(a.file, a.cells?.[0], a.lines?.[0], a.file)} の${a.cells ? `セル${a.cells[0]}〜${a.cells[1]}` : `${a.lines?.[0]}〜${a.lines?.[1]}行`}を見ていた（${Math.round((a.t1 - a.t0) / 1000)}秒）`;
      case 'terminal':
        return `${time} ターミナル: <code>${esc(a.command)}</code> → 終了コード ${a.exitCode ?? '不明'}`;
      case 'debug':
        return `${time} デバッグ: ${esc(`${a.event} ${a.detail}`)}${a.file ? `（${link(a.file, undefined, a.line)}）` : ''}`;
      case 'diagnostics':
        return `${time} ${link(a.file, a.cell)} にエラー表示: ${esc(a.messages.join(' / '))}`;
    }
  };

  // 確認の質問と回答。過去の判断からの推測を添えていたら、その確かめた結果と元にした判断も
  const question = (q?: Question, inf?: Inference) => {
    if (!q) return '';
    const state =
      q.status === 'answered'
        ? `<p class="answer">回答: ${q.answer?.via === 'inference' ? '推測が合っていた' : esc(q.answer?.text ?? '')}</p>`
        : q.status === 'dismissed'
          ? '<p class="none">答えなかった</p>'
          : '<p class="none">未回答（サイドバーの「確認の質問」から答えられます）</p>';
    const guess = inf ? `<p class="inf" title="${esc(`元にした判断:\n${inf.basis.map(pastDecisionLabel).join('\n')}\n\n推測の筋道: ${inf.reasoning}`)}">💡 推測（${INFERENCE_LABEL[inf.status]}）: ${esc(inf.text)}</p>` : '';
    return `<div class="qa ${q.status}"><p class="q">❓ ${esc(q.text)}</p>${guess}${state}</div>`;
  };

  // 理由の評価。確認だけのステップは、見て気づいたことを説明していたときだけ出す（説明しないのが普通なので）
  const badge = (s: StoredStep) => {
    const e = s.evaluation;
    const check = s.summary?.step_type === 'check';
    if (!e || (check && e.level !== 'strong')) return '';
    return `<span class="badge level-${e.level}" title="${esc(`${e.categories.join(', ')}: ${e.reason}`)}">${check ? '説明あり' : LEVEL_LABEL[e.level]}</span>`;
  };

  const card = (s: StoredStep) => {
    const sum = s.summary;
    const noReason = !sum || sum.rationale.includes(NO_REASON);
    const stepActions = s.actionGroups.flatMap((g) => g.actions.map((id) => actions.get(id)).filter((a): a is Action => !!a));
    return `
    <li class="step ${s.kind}" id="${s.id}">
      <div class="meta"><span class="t">${at(s.t0)}〜${at(s.t1)}</span><span class="badge">${KIND_LABEL[s.kind]}</span>${sum ? `<span class="badge ${sum.knowledge}">${sum.knowledge === 'general' ? '一般的なコーディング' : '業務・データ固有'}</span>` : ''}${sum?.step_type === 'check' ? '<span class="badge" title="中身を見ただけで、まだ何も選んでいない（理由の評価と質問はしない）">確認だけ</span>' : ''}${badge(s)}</div>
      <p class="decision">${esc(sum?.decision_and_actions ?? '（要約なし）')}</p>
      <dl>
        <dt>理由</dt><dd class="${noReason ? 'none' : ''}">${esc(noReason ? '発話では理由を述べていない' : sum.rationale)}</dd>
        <dt>経緯</dt><dd>${esc(sum?.progression ?? '')}</dd>
      </dl>
      ${question(s.question, s.inference)}
      <details data-key="step-${s.id}">
        <summary>発話 ${s.sentences.length} ・ 操作 ${stepActions.length}</summary>
        ${s.sentences.length ? `<ul class="said">${s.sentences.map((x) => `<li><span class="t">${at(x.t0)}</span> ${esc(x.text)}${x.original ? ` <span class="orig" title="補正前: ${esc(x.original)}">補正</span>` : ''}</li>`).join('')}</ul>` : ''}
        ${stepActions.length ? `<ul class="did">${stepActions.map((a) => `<li>${action(a)}</li>`).join('')}</ul>` : ''}
      </details>
    </li>`;
  };

  // 小作業のまとまり: 業務・データ固有の判断を目立たせ、一般的なコーディングは畳む
  const taskCard = (t: Task) => {
    const members = t.steps.map((id) => stepById.get(id)).filter((s): s is StoredStep => !!s);
    const domain = members.filter((s) => s.summary?.knowledge !== 'general');
    const general = members.filter((s) => s.summary?.knowledge === 'general');
    return `
    <li class="task">
      <div class="meta"><span class="t">${at(t.t0)}〜${at(t.t1)}</span><span>ステップ ${members.length}</span></div>
      <h2>${esc(t.title)}</h2>
      <p class="task-summary">${esc(t.summary)}</p>
      ${domain.length ? `<h3>業務・データ固有の判断</h3><ol class="steps">${domain.map(card).join('')}</ol>` : '<p class="none">業務・データ固有の判断はありません。</p>'}
      ${general.length ? `<details class="general" data-key="general-${t.id}"><summary>一般的なコーディング（${general.length}）</summary><ol class="steps">${general.map(card).join('')}</ol></details>` : ''}
    </li>`;
  };

  return `
  <h1>${esc(dateLabel(info.startedAt))} の記録</h1>
  <p class="summary">${minutes} 分 ・ 発話 ${info.stats?.utterances ?? 0} ・ 操作 ${info.stats?.actions ?? 0} ・ ステップ ${steps.length}${info.device ? ` ・ マイク: ${esc(info.device)}` : ''}</p>
  ${stored?.tasks?.length ? `<ol class="tasks">${stored.tasks.map(taskCard).join('')}</ol>` : steps.length ? `<ol class="steps">${steps.map(card).join('')}</ol>` : '<p>意思決定ステップはまだありません（処理が終わっていないか、発話がありませんでした）。</p>'}`;
}
