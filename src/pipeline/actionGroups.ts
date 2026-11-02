// 操作のまとめ（論文の Action Linking Module）と、LLM に渡すための操作の説明文。vscode に依存しない。
// 論文は「同じ要素への同じ種類の連続した操作」だけをまとめる方式（GAv3）が最良だった。
// コーディングでは「要素」を、ノートブックならセル、.py なら関数（無ければファイル）とする。
import type { Action } from '../capture/actions';

export interface ActionGroup {
  id: string;
  kind: Action['kind'];
  element: string;
  t0: number;
  t1: number;
  actions: Action[];
}

// 操作の対象（要素）
export function elementOf(a: Action): string {
  switch (a.kind) {
    case 'edit':
      return a.cell !== undefined ? `${a.file}#${a.cell}` : `${a.file}:${a.symbols[0] ?? ''}`;
    case 'cell-run':
      return `${a.file}#${a.cell}`;
    case 'view':
      return a.file;
    case 'diagnostics':
      return a.cell !== undefined ? `${a.file}#${a.cell}` : a.file;
    case 'terminal':
      return 'terminal';
    case 'debug':
      return 'debug';
  }
}

// エラー表示は、入力の途中で一瞬だけ出る構文エラーが大半なので、しばらく残ったものだけを使う。
// セル実行のエラーは cell-run の側にあるので重ねない
export function persistentDiagnostics(actions: Action[], minMs = 10_000): Action[] {
  const sorted = [...actions].sort((a, b) => a.t0 - b.t0);
  return sorted.filter((a, i) => {
    if (a.kind !== 'diagnostics') return true;
    if (a.errors === 0) return false;
    if (a.messages.every((m) => m.includes('Cell Execution Error'))) return false;
    const next = sorted.slice(i + 1).find((b) => b.kind === 'diagnostics' && elementOf(b) === elementOf(a));
    return !next || next.t0 - a.t0 >= minMs;
  });
}

// 閲覧とエラー表示は、それだけでは発話の根拠として弱い（見ていた・出ていただけ）
export const isWeak = (g: Pick<ActionGroup, 'kind'>) => g.kind === 'view' || g.kind === 'diagnostics';

// セルや関数は Figma の要素より大きく、同じセルへの編集が数分続くこともあるので、間が空いたら別のまとまりにする
const MAX_GROUP_GAP_MS = 15_000;

export function groupActions(actions: Action[], startIndex = 0): ActionGroup[] {
  const groups: ActionGroup[] = [];
  for (const a of [...actions].sort((x, y) => x.t0 - y.t0)) {
    const last = groups[groups.length - 1];
    const element = elementOf(a);
    if (last && last.kind === a.kind && last.element === element && a.t0 - last.t1 <= MAX_GROUP_GAP_MS) {
      last.actions.push(a);
      last.t1 = Math.max(last.t1, a.t1);
    } else {
      groups.push({ id: `g${startIndex + groups.length + 1}`, kind: a.kind, element, t0: a.t0, t1: a.t1, actions: [a] });
    }
  }
  return groups;
}

export const clock = (t: number, origin: number) => {
  const s = Math.max(0, Math.round((t - origin) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const changedLines = (diff: string, max: number) => {
  const lines = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  return lines.length > max ? [...lines.slice(0, max), `…（ほか ${lines.length - max} 行）`] : lines;
};

const where = (file: string, cell?: number) => (cell !== undefined ? `${file} のセル${cell}` : file);

// 操作 1 つを、LLM に渡す説明にする
export function describeAction(a: Action, origin: number, maxLines = 8): string {
  switch (a.kind) {
    case 'edit': {
      const sym = a.symbols.length ? `（${a.symbols.join(', ')}）` : '';
      return [`${where(a.file, a.cell)}${sym} を編集（${a.lines[0]}〜${a.lines[1]}行、+${a.added}/-${a.removed}${a.undo ? '、元に戻すを含む' : ''}）`, ...changedLines(a.diff, maxLines).map((l) => `    ${l}`)].join('\n');
    }
    case 'cell-run': {
      const outputs = a.outputs
        .map((o) => (o.image ? `[画像 ${o.image}]` : (o.text ?? '').split('\n').slice(0, 4).join('\n')))
        .filter(Boolean)
        .join('\n')
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n');
      return `${where(a.file, a.cell)} を実行 → ${a.success === false ? '失敗' : '成功'}${outputs ? `\n${outputs}` : ''}`;
    }
    case 'view':
      return `${a.file} の${a.cells ? `セル${a.cells[0]}〜${a.cells[1]}` : `${a.lines?.[0]}〜${a.lines?.[1]}行`}${a.symbols.length ? `（${a.symbols.join(', ')}）` : ''}を見ていた（${Math.round((a.t1 - a.t0) / 1000)}秒）`;
    case 'terminal':
      return `ターミナルで \`${a.command}\` を実行 → 終了コード ${a.exitCode ?? '不明'}`;
    case 'debug':
      return `デバッグ: ${a.event} ${a.detail}${a.file ? `（${a.file}:${a.line}）` : ''}`;
    case 'diagnostics':
      return `${where(a.file, a.cell)} にエラー表示 ${a.errors} 件: ${a.messages.join(' / ')}`;
  }
}

// 操作のまとまりを、LLM に渡す説明にする（同じ種類の連続した操作なので、時刻と中身を並べる）
export function describeGroup(g: ActionGroup, origin: number): string {
  const body = g.actions.map((a) => `  [${clock(a.t0, origin)}] ${describeAction(a, origin).replace(/\n/g, '\n  ')}`).join('\n');
  return `${g.id}（${clock(g.t0, origin)}〜${clock(g.t1, origin)}）\n${body}`;
}

// 操作のまとまりに含まれる画像（セルのグラフ出力など）
export function imagesOf(g: ActionGroup): string[] {
  return g.actions.flatMap((a) => (a.kind === 'cell-run' ? a.outputs.flatMap((o) => (o.image ? [o.image] : [])) : []));
}
