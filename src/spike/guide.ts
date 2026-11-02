// Phase 0: 手動確認の手順ページ。上から順にボタンを押せば進められるようにする。
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Spike } from './commands';

const READING = [
  'まずはCSVを読み込んで、データフレームの中身を確認しよう。',
  '欠損値が結構あるな。とりあえずdropnaで落とすけど、本当は補完した方がいいかもしれない。',
  'ユーザーごとに集計したいので、groupbyしてaggで平均と件数を出す。applyは遅いから使わない。',
  'このforループはnumpyのwhereでベクトル化できそうだ。',
  'えーと、KeyErrorが出てる。列名のタイプミスかな。',
  '前にmergeで行が増えて困ったことがあるから、validateにone_to_oneを指定しておく。',
  '関数が長くなってきたので、前処理の部分をpreprocessという関数に切り出す。',
  'polarsでも書けるけど、他の人が読みやすいようにpandasのままにしておこう。',
  'グラフのラベルが重なってるので、tight_layoutを呼んでおく。',
  'うーん、このセルを実行するたびに結果が変わるな。乱数のシードを固定しよう。',
  '型ヒントを付けておくと、あとでPylanceが警告してくれるので楽になる。',
  'テストはpytestで書いて、境界値のケースを先に押さえておく。',
];

// 操作の記録で、これから何をするかの目印（後で区間ごとに集計する）
export const MARKS = [
  '手で入力する',
  '貼り付ける',
  'Copilot の補完を受け入れる',
  '元に戻す・やり直す',
  '保存する',
  'Claude Code に編集させる',
  'Copilot のチャット・エージェントに編集させる',
  'セルを実行する',
  'ターミナルで実行する',
  'デバッグする',
];

// MARKS と同じ順番で、それぞれのやり方
const HOW_TO = [
  'analysis.py に数行、手で書く',
  '1 行コピーして、別の場所に貼り付ける',
  'インラインの提案（薄い灰色の文字）が出たら Tab で受け入れる。出なければ飛ばしてよい',
  'Ctrl+Z で戻し、Ctrl+Y でやり直す',
  'Ctrl+S で保存する',
  'このウィンドウの Claude Code に「analysis.py に docstring を足して」などと頼み、変更を受け入れる',
  'Copilot Chat に analysis.py を少し直させ、変更を受け入れる',
  'explore.ipynb を開き、右上の「カーネルの選択」で .venv を選ぶ。セルを少し書き換えて、上から順に実行する（グラフのセルも）',
  'メニューの「表示」→「ターミナル」を開き、uv run python analysis.py を実行する',
  'analysis.py の行番号の左をクリックしてブレークポイントを置き、右上の ▷ の横の ∨ から「Python Debugger: Debug Python File」を選ぶ',
];

type Mode = 'idle' | 'reading' | 'free' | 'operations';

let panel: vscode.WebviewPanel | undefined;

export function openGuide(context: vscode.ExtensionContext, spike: Spike): void {
  if (panel) {
    panel.reveal();
    return;
  }
  const current = vscode.window.createWebviewPanel('clearfairy.guide', 'ClearFairy: Phase 0 の確認', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true });
  panel = current;

  let mode: Mode = 'idle';
  let running: string | undefined;
  let activeMark: string | undefined;
  const done = new Set<string>();
  const marked = new Set<string>();

  const post = () =>
    void current.webview.postMessage({ mode, running, device: spike.device, done: [...done], marked: [...marked], activeMark, recording: spike.isRecording });

  // ステータスバーから録音や記録を止めた場合も、手順ページの状態を合わせる
  const sub = spike.onDidChange(() => {
    if ((mode === 'reading' || mode === 'free') && !spike.isRecording) {
      // stopEventLog() がこのハンドラを再び呼ぶので、先に状態を戻しておく
      const finished = mode;
      mode = 'idle';
      done.add(finished);
      if (finished === 'free') spike.stopEventLog();
    } else if (mode === 'operations' && !spike.isLogging) {
      done.add('operations');
      mode = 'idle';
      activeMark = undefined;
    }
    post();
  });

  // 実行中は他のボタンを押せないようにする。action が false を返したら（取り消しなど）済にしない
  const run = async (id: string, action: () => Promise<boolean>) => {
    running = id;
    post();
    try {
      if (await action()) done.add(id);
    } finally {
      running = undefined;
      post();
    }
  };

  current.webview.onDidReceiveMessage(async (m: { action: string; label?: string }) => {
    switch (m.action) {
      case 'ready':
        post();
        break;
      case 'environment':
        await run('environment', () => spike.environment());
        break;
      case 'languageModel':
        await run('languageModel', () => spike.languageModel());
        break;
      case 'reading':
      case 'free': {
        if (mode !== 'idle' || running) break;
        const id = m.action;
        // 録音の準備（モデルの読み込み）には数秒かかるので、その間は実行中にしておく
        await run(id, async () => {
          // 独り言は、声と操作がそろったデータにするため、操作ログも同時に取る
          if (id === 'free') {
            spike.startEventLog('free');
            spike.mark('独り言');
          }
          if (await spike.startRecording(id)) mode = id;
          else if (id === 'free') spike.stopEventLog();
          return false; // 済にするのは録音を止めたとき
        });
        break;
      }
      case 'stopRecording':
        await spike.stopRecording(); // 状態は onDidChange で合わせる
        break;
      case 'operations':
        if (mode !== 'idle') break;
        spike.startEventLog('operations');
        mode = 'operations';
        break;
      case 'mark':
        if (mode !== 'operations' || !m.label) break;
        spike.mark(m.label);
        marked.add(m.label);
        activeMark = m.label;
        break;
      case 'stopOperations':
        spike.stopEventLog(); // 状態は onDidChange で合わせる
        break;
    }
    post();
  });

  current.onDidDispose(() => {
    sub.dispose();
    panel = undefined;
  });
  context.subscriptions.push(current);
  current.webview.html = html(current.webview);
}

function html(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const reading = READING.map((s) => `<li>${esc(s)}</li>`).join('');
  const operations = MARKS.map(
    (label, i) => `
      <li class="op" data-label="${esc(label)}">
        <button class="secondary" data-action="mark" data-label="${esc(label)}">始める</button>
        <div><strong>${esc(label)}</strong><span class="desc">${esc(HOW_TO[i])}</span></div>
        <span class="check">✓</span>
      </li>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 8px 24px 48px; max-width: 760px; line-height: 1.6; }
  h1 { font-size: 1.5em; margin-bottom: 4px; }
  h2 { font-size: 1.15em; margin: 32px 0 8px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  h2 .time { font-weight: normal; color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-left: 8px; }
  .lead, .note { color: var(--vscode-descriptionForeground); }
  .step { display: flex; gap: 12px; align-items: flex-start; margin: 12px 0; }
  .step .desc, .op .desc { display: block; color: var(--vscode-descriptionForeground); font-size: 0.92em; }
  button { font: inherit; padding: 4px 14px; border: none; border-radius: 2px; cursor: pointer; white-space: nowrap; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.stop { background: var(--vscode-charts-red); color: #fff; }
  button:disabled { opacity: 0.4; cursor: default; }
  .check { visibility: hidden; color: var(--vscode-charts-green); font-weight: bold; }
  .done > .check, .op.done .check { visibility: visible; }
  ol.reading { background: var(--vscode-textBlockQuote-background); border-left: 4px solid var(--vscode-textBlockQuote-border); padding: 12px 12px 12px 40px; font-size: 1.1em; }
  ol.reading li { margin: 6px 0; }
  ol.ops { list-style: none; padding: 0; counter-reset: op; }
  .op { display: flex; gap: 12px; align-items: flex-start; padding: 8px; border-radius: 4px; counter-increment: op; }
  .op > div::before { content: counter(op) ". "; font-weight: bold; }
  .op.active { outline: 1px solid var(--vscode-focusBorder); background: var(--vscode-list-hoverBackground); }
  .rec { color: var(--vscode-charts-red); font-weight: bold; }
</style>
</head>
<body>
  <h1>Phase 0 の確認</h1>
  <p class="lead">上から順にボタンを押して進めてください。結果は自動で保存されます（<code>.clearfairy/spike/</code>）。すべて終わったら、元のウィンドウの Claude Code に「終わった」と伝えてください。</p>

  <h2>A. 環境と Copilot<span class="time">2 分</span></h2>
  <div class="step" id="environment"><button data-action="environment">環境を確認する</button><div>結果は下の「出力」パネルに出ます。<span class="desc">数秒で終わります。</span></div><span class="check">✓</span></div>
  <div class="step" id="languageModel"><button data-action="languageModel">Copilot の言語モデルを試す</button><div>画面の上にモデルの一覧が出たら、どれか 1 つを選ぶ（迷ったら一番上）。<span class="desc">言語モデルの利用の許可を求められたら「許可」を押す。3 つの質問を順に試します。</span></div><span class="check">✓</span></div>

  <h2>B. 声<span class="time">5 分</span></h2>
  <p class="note" id="mic">Windows の既定のマイクで録音します。</p>
  <div class="step" id="reading"><button data-action="reading">読み上げを録音する</button><div>押したら、下の 12 文を、ふだんの読み方で、文の間に少し間を空けて読む。<span class="desc">読み終えたら「録音を止める」を押す。</span></div><span class="check">✓</span></div>
  <ol class="reading">${reading}</ol>
  <div class="step" id="free"><button data-action="free">独り言を録音する</button><div>押したら <code>analysis.py</code> を開き、眺めたり直したりしながら、考えていることを 1〜2 分口に出す。<span class="desc">操作の記録も同時に取ります。終わったら、このページに戻って「録音を止める」を押す。</span></div><span class="check">✓</span></div>

  <h2>C. 操作の記録<span class="time">10 分</span></h2>
  <div class="step" id="operations"><button data-action="operations">操作の記録を始める</button><div>記録を始めたら、1 から順に「始める」を押してから、その操作をする。<span class="desc">できない操作は飛ばして構いません。</span></div><span class="check">✓</span></div>
  <ol class="ops">${operations}</ol>
  <div class="step"><button class="stop" data-action="stopOperations" id="stopOperations">操作の記録を止める</button></div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const labels = { environment: '環境を確認する', languageModel: 'Copilot の言語モデルを試す', reading: '読み上げを録音する', free: '独り言を録音する', operations: '操作の記録を始める' };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (b && !b.disabled) vscode.postMessage({ action: b.dataset.action, label: b.dataset.label });
  });

  window.addEventListener('message', ({ data: s }) => {
    const busy = s.mode !== 'idle' || s.running !== undefined;
    for (const id of Object.keys(labels)) {
      const step = document.getElementById(id);
      const button = step.querySelector('button');
      step.classList.toggle('done', s.done.includes(id));
      const recordingHere = s.mode === id && (id === 'reading' || id === 'free');
      if (recordingHere) {
        button.textContent = '■ 録音を止める';
        button.dataset.action = 'stopRecording';
        button.classList.add('stop');
        button.disabled = false;
      } else {
        button.textContent = s.running === id ? '実行中…' : s.mode === id ? '記録中' : labels[id];
        button.dataset.action = id;
        button.classList.remove('stop');
        button.disabled = busy;
      }
    }
    document.getElementById('mic').innerHTML = s.device
      ? 'マイク: <strong>' + s.device.replace(/</g, '&lt;') + '</strong>（Windows の既定のマイク）'
      : 'Windows の既定のマイクで録音します。';
    for (const li of document.querySelectorAll('.op')) {
      li.classList.toggle('done', s.marked.includes(li.dataset.label));
      li.classList.toggle('active', s.activeMark === li.dataset.label);
      li.querySelector('button').disabled = s.mode !== 'operations';
    }
    document.getElementById('stopOperations').disabled = s.mode !== 'operations';
  });

  vscode.postMessage({ action: 'ready' });
</script>
</body>
</html>`;
}
