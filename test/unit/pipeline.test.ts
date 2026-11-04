// vscode に依存しない処理の単体テスト（npm run test:unit）
import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Action } from '../../src/capture/actions';
import { describeAction, groupActions, persistentDiagnostics } from '../../src/pipeline/actionGroups';
import { isNoiseUtterance, noiseOf, toSentences } from '../../src/pipeline/sentences';
import { buildSteps, isJustified, makeGroups, makeTasks, NO_REASON, normalizeSummary, type Step } from '../../src/pipeline/steps';
import { splitWindows } from '../../src/pipeline/windows';

const edit = (id: string, t: number, cell: number, diff = '+x'): Action => ({ kind: 'edit', id, t0: t, t1: t, file: 'a.ipynb', cell, lines: [1, 1], symbols: [], diff, added: 1, removed: 0 });
const run = (id: string, t: number, cell: number): Action => ({ kind: 'cell-run', id, t0: t, t1: t, file: 'a.ipynb', cell, success: true, source: '', outputs: [] });

describe('文への分割と雑音', () => {
  it('Whisper の幻聴・同じ文字の繰り返し・相づちに印を付ける', () => {
    assert.equal(noiseOf('ご視聴ありがとうございました'), 'hallucination');
    assert.equal(noiseOf('おわり'), 'hallucination');
    assert.equal(noiseOf('シィィィィィィィ'), 'hallucination');
    assert.equal(noiseOf('ん'), 'filler');
    assert.equal(noiseOf('うーん、'), 'filler');
    assert.equal(noiseOf('商品間では比較したいから横並べの方がいいな'), undefined);
  });

  it('音声の回答から、まるごと雑音の発話だけを除く', () => {
    assert.equal(isNoiseUtterance('ご視聴ありがとうございました'), true);
    assert.equal(isNoiseUtterance('はい'), true);
    assert.equal(isNoiseUtterance('はい。店舗によって仕入れ価格が違います。'), false);
  });

  it('発話を文に分け、時刻を文字数で配分する', () => {
    const s = toSentences([{ start: 0, end: 4000, text: '欠損がある。消すと減るなあ。' }]);
    assert.deepEqual(
      s.map((x) => x.text),
      ['欠損がある。', '消すと減るなあ。'],
    );
    assert.equal(s[0].t0, 0);
    assert.equal(s[1].t1, 4000);
    assert.ok(s[0].t1 > 0 && s[0].t1 < 4000);
  });
});

describe('操作のまとめ', () => {
  it('同じセルへの同じ種類の連続した操作だけをまとめる（GAv3）', () => {
    const groups = groupActions([edit('a1', 1, 3), edit('a2', 2, 3), run('a3', 3, 3), edit('a4', 4, 3), edit('a5', 5, 4)]);
    assert.deepEqual(
      groups.map((g) => g.actions.map((a) => a.id)),
      [['a1', 'a2'], ['a3'], ['a4'], ['a5']],
    );
  });

  it('入力の途中で一瞬だけ出たエラー表示は除き、残ったものだけ使う', () => {
    const diag = (id: string, t: number, errors: number, message = '式が必要です（Pylance）'): Action => ({ kind: 'diagnostics', id, t0: t, t1: t, file: 'a.ipynb', cell: 1, errors, warnings: 0, messages: errors ? [message] : [] });
    const kept = persistentDiagnostics([diag('d1', 0, 3), diag('d2', 2000, 0), diag('d3', 5000, 1, '"x" が定義されていません'), diag('d4', 30_000, 1, 'ModuleNotFoundError（Cell Execution Error）')]);
    assert.deepEqual(
      kept.map((a) => a.id),
      ['d3'],
    );
  });

  it('編集の説明に、変更した行を入れる', () => {
    const text = describeAction(edit('a1', 0, 13, '@@ -1 +1 @@\n-    # .drop_nulls()\n+    .drop_nulls()'));
    assert.match(text, /セル13 を編集/);
    assert.match(text, /\+    \.drop_nulls\(\)/);
  });
});

describe('窓への分割', () => {
  it('上限を超えないように、上限に近いところの一番長い間で切る', () => {
    const sentences = Array.from({ length: 30 }, (_, i) => ({ id: `s${i + 1}`, t0: i * 1000 + (i >= 20 ? 60_000 : 0), t1: i * 1000 + 500, text: 'x' }));
    const windows = splitWindows(sentences, [], { maxSentences: 25, maxActions: 40 });
    assert.equal(windows.length, 2);
    assert.equal(windows[0].sentences.length, 20, '20 文目と 21 文目の間の長い間で切る');
    assert.equal(windows[1].sentences.length, 10);
  });
});

describe('ステップの組み立て', () => {
  const s = (id: string, t: number) => ({ id, t0: t, t1: t + 1000, text: id });
  const sentences = [s('s1', 0), s('s2', 2000), s('s3', 10_000), s('s4', 20_000), s('s5', 40_000)];
  const groups = makeGroups([['s1', 's2'], ['s3'], ['s4'], ['s5']], sentences, 0);
  const actionGroups = groupActions([edit('a1', 3000, 1), run('a2', 11_000, 1), edit('a3', 21_000, 2), edit('a4', 500_000, 9), { kind: 'view', id: 'a5', t0: 41_000, t1: 45_000, file: 'a.ipynb', cells: [1, 2], symbols: [] }]);

  it('LLM が入れ忘れた文も、それだけのまとまりとして残す', () => {
    const g = makeGroups([['s1']], [s('s1', 0), s('s2', 1000)], 0);
    assert.deepEqual(
      g.map((x) => x.sentences.map((y) => y.id)),
      [['s1'], ['s2']],
    );
  });

  it('結び付き・割り当て・結び付かなかった操作から、ステップを作る', () => {
    // G1→g1、G2→g2（同じセルなので同じステップにはしない）、G3→g3、G4 は left
    const steps = buildSteps(groups, actionGroups, { G1: ['g1'], G2: ['g2'], G3: ['g3'] }, { G4: 'left' });
    const shape = steps.map((x) => ({ kind: x.kind, s: x.sentences.map((y) => y.id), a: x.actionGroups.map((g) => g.id) }));
    assert.deepEqual(shape, [
      { kind: 'linked', s: ['s1', 's2'], a: ['g1'] },
      { kind: 'linked', s: ['s3'], a: ['g2'] },
      // G4 は left で G3 と同じステップ。閲覧 g4 は 30 秒以内なので補足として入る
      { kind: 'linked', s: ['s4', 's5'], a: ['g3', 'g4'] },
      // 近くに同じ要素のステップが無い、説明の無い編集は「操作だけのステップ」
      { kind: 'action-only', s: [], a: ['g5'] },
    ]);
  });

  it('同じ操作に結び付いた近くの発話のまとまりは、同じステップにする', () => {
    const steps = buildSteps(groups, actionGroups, { G1: ['g1'], G2: ['g1', 'g2'] }, {});
    assert.deepEqual(
      steps[0].sentences.map((x) => x.id),
      ['s1', 's2', 's3'],
    );
  });
});

describe('LLM の返した要約', () => {
  it('項目が欠けていても、後の処理が落ちない形にする', () => {
    const summary = normalizeSummary({ decision_and_actions: ' 欠損行を除いた ' }, 'decision');
    assert.deepEqual(summary, { decision_and_actions: '欠損行を除いた', rationale: NO_REASON, progression: '', knowledge: 'domain', step_type: 'decision' });
    assert.equal(isJustified({ summary, evaluation: { categories: ['S-SR'], level: 'strong', reason: '' } }), false);
  });
});

describe('小作業のまとまり', () => {
  const step = (id: string, t: number): Step => ({ id, t0: t, t1: t + 1, kind: 'talk', sentences: [], actionGroups: [] });
  const steps = ['st1', 'st2', 'st3', 'st4', 'st5'].map((id, i) => step(id, i * 10));

  it('入れ忘れたステップは直前のまとまりに入れ、すべてのステップを時刻順に 1 回ずつ入れる', () => {
    const tasks = makeTasks(
      [
        { title: '読み込み', steps: ['st1', 'st2'] },
        { title: 'グラフ', steps: ['st4', 'st5', 'st2'] },
      ],
      steps,
    );
    assert.deepEqual(
      tasks.map((t) => [t.title, t.steps]),
      [
        ['読み込み', ['st1', 'st2', 'st3']],
        ['グラフ', ['st4', 'st5']],
      ],
    );
    assert.equal(tasks[1].t0, 30);
  });
});
