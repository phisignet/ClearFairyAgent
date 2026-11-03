// 記録したセッションの意思決定ステップを、時系列のカードで見る画面。
// カードには判断・理由・経緯と、元の発話（補正前の文も）・操作（差分・実行結果・グラフ画像）を載せ、
// セルや行をクリックするとその場所を開く。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Action } from '../capture/actions';
import type { SessionInfo } from '../session/session';
import { NO_REASON, type Evaluation, type Inference, type Question, type StepSummary, type Task } from '../pipeline/steps';

interface StoredStep {
  id: string;
  t0: number;
  t1: number;
  kind: 'linked' | 'talk' | 'action-only';
  summary?: StepSummary;
  evaluation?: Evaluation;
  question?: Question;
  inference?: Inference;
  sentences: { id: string; t0: number; text: string; original?: string }[];
  actionGroups: { id: string; kind: string; element: string; actions: string[] }[];
}

const KIND_LABEL = { linked: '発話＋操作', talk: '発話だけ', 'action-only': '操作だけ' };
const LEVEL_LABEL = { strong: '理由: 十分', weak: '理由: 弱い', empty: '理由: 無い' };
const INFERENCE_LABEL = { open: '確かめていない', accepted: '合っている', revised: '直して答えた', rejected: '違う' };

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const readJsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

const panels = new Map<string, vscode.WebviewPanel>();

export function openSessionView(dir: string): void {
  const existing = panels.get(dir);
  if (existing) {
    existing.webview.html = render(existing.webview, dir);
    existing.reveal();
    return;
  }
  const info = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as SessionInfo;
  const panel = vscode.window.createWebviewPanel('clearfairy.session', `ClearFairy: ${dateLabel(info.startedAt)} の記録`, vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(dir)],
  });
  panels.set(dir, panel);
  panel.onDidDispose(() => panels.delete(dir));
  panel.webview.onDidReceiveMessage((m: { type: string; file: string; cell?: number; line?: number }) => {
    if (m.type === 'open') void openLocation(m.file, m.cell, m.line);
  });
  panel.webview.html = render(panel.webview, dir);
}

// 開いている記録の画面を描き直す（回答を反映したときなど）
export function refreshSessionView(dir: string): void {
  const panel = panels.get(dir);
  if (panel) panel.webview.html = render(panel.webview, dir);
}

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

function render(webview: vscode.Webview, dir: string): string {
  const info = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8')) as SessionInfo;
  const stepsFile = join(dir, 'steps.json');
  const stored = existsSync(stepsFile) ? (JSON.parse(readFileSync(stepsFile, 'utf8')) as { steps: StoredStep[]; tasks?: Task[] }) : { steps: [] as StoredStep[], tasks: undefined };
  const steps = stored.steps;
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const actions = new Map(readJsonl<Action>(join(dir, 'actions.jsonl')).map((a) => [a.id, a]));
  const at = (t: number) => {
    const s = Math.max(0, Math.round((t - info.startedAt) / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const minutes = info.endedAt ? Math.round((info.endedAt - info.startedAt) / 60000) : 0;
  const nonce = Math.random().toString(36).slice(2);

  const link = (file: string, cell?: number, line?: number) => {
    const label = cell !== undefined ? `${file} のセル${cell}` : line !== undefined ? `${file}:${line}` : file;
    return `<a href="#" data-open="${esc(JSON.stringify({ file, cell, line }))}">${esc(label)}</a>`;
  };
  const diff = (text: string) =>
    `<pre class="diff">${text
      .split('\n')
      .filter((l) => /^[+-]/.test(l))
      .map((l) => `<span class="${l.startsWith('+') ? 'add' : 'del'}">${esc(l)}</span>`)
      .join('\n')}</pre>`;

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
        return `${time} ${link(a.file, undefined, a.lines?.[0])} の${a.cells ? `セル${a.cells[0]}〜${a.cells[1]}` : `${a.lines?.[0]}〜${a.lines?.[1]}行`}を見ていた（${Math.round((a.t1 - a.t0) / 1000)}秒）`;
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
    const basis = inf?.basis.map((d) => `${d.session ? `${new Date(d.at).toLocaleDateString('ja-JP')} の記録` : 'この記録'}「${d.decision}」 → ${d.rationale}`).join('\n');
    const guess = inf ? `<p class="inf" title="${esc(`元にした判断:\n${basis}\n\n推測の筋道: ${inf.reasoning}`)}">💡 推測（${INFERENCE_LABEL[inf.status]}）: ${esc(inf.text)}</p>` : '';
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
      <details>
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
      ${general.length ? `<details class="general"><summary>一般的なコーディング（${general.length}）</summary><ol class="steps">${general.map(card).join('')}</ol></details>` : ''}
    </li>`;
  };

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 8px 24px 48px; max-width: 860px; line-height: 1.6; }
  h1 { font-size: 1.4em; margin-bottom: 0; }
  .summary { color: var(--vscode-descriptionForeground); margin-top: 4px; }
  ol.steps, ol.tasks { list-style: none; padding: 0; }
  .task { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 16px; margin: 16px 0; background: var(--vscode-sideBar-background); }
  .task h2 { font-size: 1.15em; margin: 4px 0; }
  .task h3 { font-size: 0.95em; color: var(--vscode-descriptionForeground); margin: 12px 0 0; }
  .task-summary { margin: 4px 0 8px; }
  .general > summary { color: var(--vscode-descriptionForeground); }
  .badge.domain { border-color: var(--vscode-charts-green); color: var(--vscode-charts-green); }
  .badge.general { color: var(--vscode-descriptionForeground); }
  p.none { color: var(--vscode-descriptionForeground); font-style: italic; }
  .step { border: 1px solid var(--vscode-panel-border); border-left-width: 4px; border-radius: 4px; padding: 10px 14px; margin: 12px 0; }
  .step.linked { border-left-color: var(--vscode-charts-blue); }
  .step.talk { border-left-color: var(--vscode-charts-purple); }
  .step.action-only { border-left-color: var(--vscode-charts-orange); }
  .meta { display: flex; gap: 10px; align-items: center; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .badge.level-strong { border-color: var(--vscode-charts-green); }
  .badge.level-weak { border-color: var(--vscode-charts-yellow); color: var(--vscode-charts-yellow); }
  .badge.level-empty { border-color: var(--vscode-charts-orange); color: var(--vscode-charts-orange); }
  .qa { border-left: 3px solid var(--vscode-charts-yellow); padding: 2px 10px; margin: 8px 0; background: var(--vscode-textBlockQuote-background); }
  .qa.answered { border-left-color: var(--vscode-charts-green); }
  .qa p { margin: 2px 0; }
  .qa .q { font-weight: 600; }
  .qa .inf { color: var(--vscode-descriptionForeground); cursor: help; }
  .badge { border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 0 8px; font-size: 0.85em; }
  .decision { font-weight: 600; margin: 6px 0; }
  dl { display: grid; grid-template-columns: 3em 1fr; gap: 2px 8px; margin: 4px 0; }
  dt { color: var(--vscode-descriptionForeground); }
  dd { margin: 0; }
  dd.none { color: var(--vscode-descriptionForeground); font-style: italic; }
  details summary { cursor: pointer; color: var(--vscode-textLink-foreground); margin-top: 6px; }
  ul.said, ul.did { padding-left: 1.2em; }
  ul.did li { margin: 4px 0; }
  .t { font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); font-size: 0.9em; }
  .orig { font-size: 0.8em; border: 1px dotted var(--vscode-descriptionForeground); border-radius: 3px; padding: 0 4px; cursor: help; }
  pre { font-family: var(--vscode-editor-font-family); font-size: 0.9em; background: var(--vscode-textBlockQuote-background); padding: 6px 8px; overflow-x: auto; margin: 4px 0; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .ok { color: var(--vscode-charts-green); }
  .ng { color: var(--vscode-charts-red); }
  img { max-width: 100%; display: block; margin: 6px 0; background: white; }
  a { color: var(--vscode-textLink-foreground); }
</style>
</head>
<body>
  <h1>${esc(dateLabel(info.startedAt))} の記録</h1>
  <p class="summary">${minutes} 分 ・ 発話 ${info.stats?.utterances ?? 0} ・ 操作 ${info.stats?.actions ?? 0} ・ ステップ ${steps.length}${info.device ? ` ・ マイク: ${esc(info.device)}` : ''}</p>
  ${stored.tasks?.length ? `<ol class="tasks">${stored.tasks.map(taskCard).join('')}</ol>` : steps.length ? `<ol class="steps">${steps.map(card).join('')}</ol>` : '<p>意思決定ステップはまだありません（処理が終わっていないか、発話がありませんでした）。</p>'}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-open]');
    if (!a) return;
    e.preventDefault();
    vscode.postMessage({ type: 'open', ...JSON.parse(a.dataset.open) });
  });
</script>
</body>
</html>`;
}
