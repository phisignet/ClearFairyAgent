// 記録を見る画面。拡張機能の側は src/ui/sessionView.ts。
import type { FromSessionPage, ToSessionPage } from './protocol';

declare function acquireVsCodeApi(): { postMessage(message: FromSessionPage): void };

const vscode = acquireVsCodeApi();
const content = document.getElementById('content')!;

// 記録中は区切りの処理が終わるたびに中身が届く。スクロールの位置と、開いている項目を保つ
window.addEventListener('message', ({ data }: MessageEvent<ToSessionPage>) => {
  if (data.type !== 'content') return;
  const details = () => [...content.querySelectorAll<HTMLDetailsElement>('details[data-key]')];
  const opened = new Set(details().filter((d) => d.open).map((d) => d.dataset.key));
  content.innerHTML = data.html;
  for (const d of details()) d.open = opened.has(d.dataset.key);
});

document.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-open]');
  if (!a) return;
  e.preventDefault();
  vscode.postMessage({ type: 'open', ...(JSON.parse(a.dataset.open!) as { file: string; cell?: number; line?: number }) });
});
