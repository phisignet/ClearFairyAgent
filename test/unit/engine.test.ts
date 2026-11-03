// 処理エンジンと記録中の逐次処理を、偽の LLM で通しで動かす（npm run test:unit）
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import type { Action } from '../../src/capture/actions';
import { Pipeline, type PipelineLlm } from '../../src/pipeline/engine';
import { LivePipeline } from '../../src/pipeline/live';
import { Prompts } from '../../src/pipeline/prompts';
import { toSentences } from '../../src/pipeline/sentences';
import type { Step } from '../../src/pipeline/steps';

// out/unit/ から見たリポジトリのルート
const prompts = new Prompts(join(__dirname, '..', '..', 'prompts'));

// プロンプトの種類を見分けて、決まった答えを返す
function fakeLlm(calls: string[]): PipelineLlm {
  const ids = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[1]);
  const answer = (prompt: string): unknown => {
    if (prompt.includes('文字起こしを校正する')) return { sentences: ids(prompt, /^(s\d+): \[/gm).map((id) => ({ id, text: id === 's2' ? 'drop_nulls で落とす' : `文 ${id}` })) };
    if (prompt.includes('密接に関連する文のまとまり')) return { groups: [ids(prompt, /^(s\d+): \[/gm)] };
    if (prompt.includes('操作の記録を結び付ける')) return { links: [{ group: ids(prompt, /^(G\d+):/gm)[0], actions: ids(prompt, /^(g\d+)（/gm) }] };
    if (prompt.includes('前後どちらのまとまり')) return { assignments: [] };
    if (prompt.includes('どれだけ説明できているかを評価')) return { reason: '理由が無い', categories: ['E'] };
    if (prompt.includes('理由を確認する質問を作る')) return { question: '欠損している売上は、業務ではどう扱いますか？' };
    if (prompt.includes('回答も踏まえて')) return { decision_and_actions: '欠損行を除いた', rationale: '欠損は返品なので売上に数えないため', progression: '集計に進んだ', knowledge: 'domain' };
    if (prompt.includes('小作業のまとまりに分ける')) return { tasks: [{ title: '集計', summary: '欠損を除いて集計した', steps: ids(prompt, /^(st\d+) \[/gm) }] };
    if (prompt.includes('意思決定ステップを要約する')) return { decision_and_actions: '欠損行を除いた', rationale: '（理由は述べていない）', progression: '集計に進んだ', knowledge: 'domain' };
    throw new Error(`知らないプロンプト: ${prompt.slice(0, 60)}`);
  };
  return {
    json: async <T>(messages: { content: unknown }[]) => {
      const prompt = String((messages[0].content as unknown[])[0]);
      calls.push(prompt.slice(0, 30));
      const value = answer(prompt) as T;
      return { value, raw: { text: JSON.stringify(value), model: 'fake', ms: 0 } };
    },
  };
}

function sessionDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clearfairy-'));
  writeFileSync(join(dir, 'session.json'), JSON.stringify({ id: 'test', startedAt: 0, speechModel: 'zipformer-ja-en' }));
  return dir;
}

const edit: Action = { kind: 'edit', id: 'a1', t0: 4000, t1: 5000, file: 'a.ipynb', cell: 3, uri: 'vscode-notebook-cell:/a.ipynb#c3', lines: [2, 2], symbols: [], diff: '@@ -1 +1 @@\n-df\n+df.drop_nulls()', added: 1, removed: 1 };

describe('処理エンジン', () => {
  it('窓を足して要約・評価し、理由の無い業務・データ固有の判断に質問を作り、回答で要約を作り直す', async () => {
    const dir = sessionDir();
    const calls: string[] = [];
    const p = new Pipeline({ dir, prompts, llm: fakeLlm(calls) });
    const sentences = toSentences([
      { start: 1000, end: 2000, text: '欠損があるな。' },
      { start: 2500, end: 3500, text: 'ドロップヌルスで落とす。' },
    ]);
    p.sentences.push(...sentences);
    const { added } = await p.addWindow({ t0: 1000, t1: 5000, sentences, actions: [edit] });
    assert.equal(added.length, 1);
    await p.summarize(added);
    await p.evaluate(added);
    const asked = await p.askQuestions(added);

    const step = asked[0] as Step;
    assert.equal(step.evaluation?.level, 'empty');
    assert.equal(step.question?.text, '欠損している売上は、業務ではどう扱いますか？');
    assert.deepEqual(step.question?.anchor, { file: 'a.ipynb', uri: 'vscode-notebook-cell:/a.ipynb#c3', cell: 3, line: 2 });
    assert.equal(sentences[1].text, 'drop_nulls で落とす', '補正が文に反映されること');

    await p.answer(step.id, '欠損は返品なので売上に数えない', 'voice');
    assert.equal(step.summary?.rationale, '欠損は返品なので売上に数えないため');
    const stored = JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8'));
    assert.equal(stored.steps[0].question.status, 'answered');
    assert.equal(stored.steps[0].question.answer.via, 'voice');

    // 保存した結果から読み直しても、質問と操作がそろっている
    writeFileSync(join(dir, 'actions.jsonl'), JSON.stringify(edit) + '\n');
    const loaded = Pipeline.load({ dir, prompts, llm: fakeLlm([]) });
    assert.equal(loaded.steps[0].question?.status, 'answered');
    assert.equal(loaded.steps[0].actionGroups[0].actions[0].id, 'a1');
  });
});

describe('確認の質問', () => {
  it('これまでの質問を見せながら 1 つずつ作り、同じ論点なら作らない', async () => {
    const dir = sessionDir();
    const prompts_: string[] = [];
    const llm: PipelineLlm = {
      json: async <T>(messages: { content: unknown }[]) => {
        const prompt = String((messages[0].content as unknown[])[0]);
        prompts_.push(prompt);
        const value = (prompt.includes('- 欠損している売上は、業務ではどう扱いますか？') ? { question: null, skip: '同じ論点を聞いた' } : { question: '欠損している売上は、業務ではどう扱いますか？' }) as T;
        return { value, raw: { text: JSON.stringify(value), model: 'fake', ms: 0 } };
      },
    };
    const p = new Pipeline({ dir, prompts, llm });
    const step = (id: string, t0: number): Step => ({
      id,
      t0,
      t1: t0 + 1000,
      kind: 'linked',
      sentences: [{ id: `s${id}`, t0, t1: t0 + 1000, text: '欠損は落とす' }],
      actionGroups: [{ id: `g${id}`, kind: 'edit', element: 'a.ipynb#3', t0, t1: t0 + 1000, actions: [edit] }],
      summary: { decision_and_actions: '欠損行を除いた', rationale: '（理由は述べていない）', progression: '', knowledge: 'domain' },
      evaluation: { categories: ['E'], level: 'empty', reason: '理由が無い' },
    });
    p.steps.push(step('st1', 1000), step('st2', 5000));
    const asked = await p.askQuestions(p.steps);
    assert.deepEqual(asked.map((s) => s.id), ['st1']);
    assert.match(prompts_[0], /（まだ無い）/);
    assert.equal(p.steps[1].questionSkipped, '同じ論点を聞いた');
    // 一度見送った判断は、中身が変わるまで聞き直さない
    assert.equal((await p.askQuestions(p.steps)).length, 0);
    assert.equal(prompts_.length, 2);
  });
});

describe('記録中の区切り', () => {
  // 偽の時計を進め、その間に始まった処理が終わるのを待つ
  const advance = async (ms: number) => {
    for (let i = 0; i < ms / 1000; i++) {
      mock.timers.tick(1000);
      for (let j = 0; j < 20; j++) await new Promise((r) => setImmediate(r));
    }
  };
  // 窓を処理するたびに pipeline/ に w<番号>-1-correct.json が残る
  const windows = (dir: string) => (existsSync(join(dir, 'pipeline')) ? readdirSync(join(dir, 'pipeline')).filter((f) => f.endsWith('-1-correct.json')).length : 0);

  it('15 秒なにも起きないと区切る', async () => {
    mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
    try {
      const dir = sessionDir();
      const live = new LivePipeline({ dir, prompts, llm: fakeLlm([]) });
      live.addUtterance({ start: 0, end: 1000, text: '欠損があるな。' });
      await advance(12_000);
      assert.equal(windows(dir), 0);
      await advance(6_000);
      assert.equal(windows(dir), 1);
      await live.finish();
    } finally {
      mock.timers.reset();
    }
  });

  it('話し続けていても、いちばん古い発話から 40 秒たつと区切る（直近 10 秒分は次に回す）', async () => {
    mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
    try {
      const dir = sessionDir();
      const live = new LivePipeline({ dir, prompts, llm: fakeLlm([]) });
      // 8 秒ごとに 1 文（数では区切られず、15 秒の無活動も起きない）
      for (let t = 0; t < 50_000; t += 8_000) {
        live.addUtterance({ start: Date.now(), end: Date.now() + 1000, text: `発話 ${t / 1000}。` });
        await advance(8_000);
        if (Date.now() < 40_000) assert.equal(windows(dir), 0, `${Date.now()}ms ではまだ区切らない`);
      }
      assert.equal(windows(dir), 1);
      assert.ok(live.pipeline.sentences.length >= 6);
      await live.finish();
    } finally {
      mock.timers.reset();
    }
  });
});

describe('記録中の逐次処理', () => {
  it('ためた発話と操作を、止めたときに処理して質問を出し、小作業のまとまりも作る', async () => {
    const dir = sessionDir();
    const asked: Step[] = [];
    const live = new LivePipeline({ dir, prompts, llm: fakeLlm([]), onQuestions: (s) => asked.push(...s) });
    live.addUtterance({ start: 1000, end: 2000, text: '欠損があるな。' });
    live.addUtterance({ start: 2500, end: 3500, text: 'ん' }); // 相づちは処理に入れない
    live.addAction(edit);
    const p = await live.finish();
    assert.equal(asked.length, 1);
    assert.equal(p.tasks.length, 1);
    assert.equal(p.sentences.length, 2, '相づちも文としては残す');
    assert.equal(p.steps[0].sentences.length, 1);
  });
});
