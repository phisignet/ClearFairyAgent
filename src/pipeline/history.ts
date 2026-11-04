// 同じワークスペースの前の記録から、理由の推測に使う過去の判断を集め、今の判断に関係しそうなものを選ぶ。vscode に依存しない。
// 記録は数分ずつと短いので、同じ記録の中だけでは推測の元になる判断が足りない。
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSessionInfo, readSteps } from './records';
import { isJustified, type PastDecision } from './steps';

// root にある記録のうち、dir の記録より前に始めたものから集める（古い順）
export function loadHistory(root: string, dir: string): PastDecision[] {
  const self = resolve(dir);
  const before = existsSync(join(dir, 'session.json')) ? readSessionInfo(dir).startedAt : Infinity;
  const past: PastDecision[] = [];
  if (!existsSync(root)) return past;
  for (const name of readdirSync(root)) {
    const d = join(root, name);
    if (resolve(d) === self) continue;
    try {
      const stored = readSteps(d);
      if (!stored || readSessionInfo(d).startedAt >= before) continue;
      for (const s of stored.steps) if (isJustified(s)) past.push({ session: name, step: s.id, at: s.t0, decision: s.summary!.decision_and_actions, rationale: s.summary!.rationale });
    } catch {
      // 書きかけの結果などは飛ばす
    }
  }
  return past.sort((a, b) => a.at - b.at);
}

// 比べるための語。英数字は識別子（列名・関数名）ごと、日本語は分かち書きしないので漢字・カタカナの 2 文字の並びにする
// （ひらがなは「した」「ため」のような、どの判断にも出る言葉が多いので使わない）
function features(text: string): Set<string> {
  const f = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z_][a-z0-9_]+/g) ?? []) f.add(w);
  for (const run of text.match(/[\p{Script=Han}\p{Script=Katakana}ー]+/gu) ?? []) {
    if (run.length === 1) f.add(run);
    for (let i = 0; i + 1 < run.length; i++) f.add(run.slice(i, i + 2));
  }
  return f;
}

// 推測に見せる過去の判断を limit 個まで選ぶ（古い順）。直近の recent 個は流れをつかむために必ず入れ、
// 残りは今の判断と語が重なるもの（多くの判断に出る語は軽く数える）を選ぶ。重なるものが少なければ、新しいもので埋める。
// 新しい順に切るだけだと、作業が長く続いたときに前の説明を拾えないため
export function selectPast(query: string, past: PastDecision[], limit: number, recent = 10): PastDecision[] {
  if (past.length <= limit) return past;
  const sets = past.map((d) => features(`${d.decision} ${d.rationale}`));
  const df = new Map<string, number>();
  for (const s of sets) for (const w of s) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log((past.length + 1) / ((df.get(w) ?? 0) + 1)) + 1;
  const q = features(query);
  const qNorm = Math.sqrt([...q].reduce((n, w) => n + idf(w) ** 2, 0));
  const score = (s: Set<string>) => {
    let dot = 0;
    let norm = 0;
    for (const w of s) {
      norm += idf(w) ** 2;
      if (q.has(w)) dot += idf(w) ** 2;
    }
    return dot === 0 ? 0 : dot / (Math.sqrt(norm) * qNorm);
  };
  const keep = new Set(past.map((_, i) => i).slice(-recent));
  // 点が同じなら新しいほうを先に
  const ranked = past
    .map((_, i) => ({ i, score: score(sets[i]) }))
    .filter(({ i }) => !keep.has(i))
    .sort((a, b) => b.score - a.score || b.i - a.i);
  for (const { i } of ranked.slice(0, limit - keep.size)) keep.add(i);
  return past.filter((_, i) => keep.has(i));
}
