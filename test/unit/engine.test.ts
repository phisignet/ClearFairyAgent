// 処理エンジンと記録中の逐次処理を、偽の LLM で通しで動かす（npm run test:unit）
import * as assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, mock } from 'node:test';
import type { Action } from '../../src/capture/actions';
import { SavedAnswers } from '../../src/pipeline/answers';
import { Pipeline, type PipelineLlm } from '../../src/pipeline/engine';
import { loadHistory, selectPast } from '../../src/pipeline/history';
import { LivePipeline } from '../../src/pipeline/live';
import { Prompts } from '../../src/pipeline/prompts';
import { toSentences } from '../../src/pipeline/sentences';
import { isJustified, type PastDecision, type Step } from '../../src/pipeline/steps';
import type { Message } from '../../src/llm/llm';

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
    if (prompt.includes('本人の過去の判断から推測する')) return { inferred_rationale: '欠損は返品なので売上に数えないため', reasoning: '前の記録で同じ欠損を返品として除いた', basis: ['p1'] };
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
    const asked = await p.analyze(added);

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

// 業務・データ固有で理由の無い判断に、質問を出したところ
const questioned = (id: string, t0: number, over: Partial<Step> = {}): Step => ({
  id,
  t0,
  t1: t0 + 1000,
  kind: 'linked',
  sentences: [{ id: `s${id}`, t0, t1: t0 + 1000, text: '欠損は落とす' }],
  actionGroups: [{ id: `g${id}`, kind: 'edit', element: 'a.ipynb#3', t0, t1: t0 + 1000, actions: [edit] }],
  summary: { decision_and_actions: '欠損行を除いた', rationale: '（理由は述べていない）', progression: '', knowledge: 'domain' },
  evaluation: { categories: ['E'], level: 'empty', reason: '理由が無い' },
  question: { id: `q${id}`, text: '欠損している売上は、業務ではどう扱いますか？', status: 'open', createdAt: t0 },
  ...over,
});

// 理由がはっきりしている判断（推測の元になる）
const justified = (id: string, t0: number, rationale: string, knowledge: 'domain' | 'general' = 'domain'): Step =>
  questioned(id, t0, {
    question: undefined,
    summary: { decision_and_actions: `判断 ${id}`, rationale, progression: '', knowledge },
    evaluation: { categories: ['S-SR'], level: 'strong', reason: '' },
  });

// LLM に渡したプロンプトを全文残す
const spy = (llm: PipelineLlm, prompts_: string[]): PipelineLlm => ({
  json: <T>(messages: Message[]) => {
    prompts_.push(String((messages[0].content as unknown[])[0]));
    return llm.json<T>(messages);
  },
});

describe('理由の推測', () => {
  const past: PastDecision = { session: '20261101-100000', step: 'st3', at: 0, decision: '返品の行を除いた', rationale: '返品は売上に数えないため' };

  it('前の記録と同じ記録の前の、理由がはっきりした業務・データ固有の判断から推測し、元にした判断を残す', async () => {
    const sent: string[] = [];
    const p = new Pipeline({ dir: sessionDir(), prompts, llm: spy(fakeLlm([]), sent), history: () => [past] });
    p.steps.push(
      justified('st1', 1000, '店舗で価格が違うため'),
      justified('st2', 2000, 'メモリを空けるため', 'general'),
      questioned('st3', 3000, { evaluation: { categories: ['W-SR'], level: 'weak', reason: '' }, question: undefined }),
      questioned('st4', 5000),
      justified('st5', 9000, '後で述べた理由'),
    );
    const inferred = await p.infer([p.steps[3]]);
    assert.deepEqual(inferred.map((s) => s.id), ['st4']);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /p1 \[前の記録.*\]\n  判断: 返品の行を除いた\n  理由: 返品は売上に数えないため/);
    assert.match(sent[0], /p2 \[この記録 00:01\]\n  判断: 判断 st1\n  理由: 店舗で価格が違うため/);
    assert.doesNotMatch(sent[0], /メモリを空けるため|後で述べた理由|^p3 \[/m, '一般的なコーディング・理由の弱い判断・後の判断は使わない');
    assert.match(sent[0], /説明が弱い・無いと評価された理由: 理由が無い/);
    const inf = p.steps[3].inference!;
    assert.equal(inf.text, '欠損は返品なので売上に数えないため');
    assert.equal(inf.status, 'open');
    assert.deepEqual(inf.basis, [past]);
    // 一度推測したら推測し直さない
    assert.equal((await p.infer([p.steps[3]])).length, 0);
    assert.equal(sent.length, 1);
  });

  it('元にできる判断が無ければ LLM を呼ばず、元にした判断を示せない推測は出さない', async () => {
    const sent: string[] = [];
    const none = new Pipeline({ dir: sessionDir(), prompts, llm: spy(fakeLlm([]), sent) });
    none.steps.push(questioned('st1', 1000));
    assert.equal((await none.infer(none.steps)).length, 0);
    assert.equal(sent.length, 0);

    const llm: PipelineLlm = {
      json: async <T>() => {
        const value = { inferred_rationale: '返品なので除くため', reasoning: '', basis: ['p9'] } as T;
        return { value, raw: { text: JSON.stringify(value), model: 'fake', ms: 0 } };
      },
    };
    const unknown = new Pipeline({ dir: sessionDir(), prompts, llm, history: () => [past] });
    unknown.steps.push(questioned('st1', 1000));
    assert.equal((await unknown.infer(unknown.steps)).length, 0);
    assert.equal(unknown.steps[0].inference, undefined);
  });

  it('合っていれば推測を回答にし、自分の言葉で答えたら推測も合わせて要約し直し、違えば推測だけ取り下げる', async () => {
    const dir = sessionDir();
    const sent: string[] = [];
    const p = new Pipeline({ dir, prompts, llm: spy(fakeLlm([]), sent), history: () => [past] });
    p.steps.push(questioned('st1', 1000), questioned('st2', 2000), questioned('st3', 3000));
    await p.infer(p.steps);
    const [accepted, revised, rejected] = p.steps;

    await p.acceptInference('st1');
    assert.equal(accepted.question?.status, 'answered');
    assert.deepEqual([accepted.question?.answer?.text, accepted.question?.answer?.via], ['欠損は返品なので売上に数えないため', 'inference']);
    assert.equal(accepted.inference?.status, 'accepted');
    assert.match(sent[sent.length - 1], /質問と並べて見せた推測: （なし）\n回答: 欠損は返品なので売上に数えないため/);

    await p.answer('st2', 'キャンセルも除く', 'voice');
    assert.equal(revised.inference?.status, 'revised');
    assert.match(sent[sent.length - 1], /質問と並べて見せた推測: 欠損は返品なので売上に数えないため\n回答: キャンセルも除く/);

    p.rejectInference('st3');
    assert.equal(rejected.inference?.status, 'rejected');
    assert.equal(rejected.question?.status, 'open', '質問には答えられる');
    await p.answer('st3', '入力漏れなので除く', 'text');
    assert.equal(rejected.inference?.status, 'rejected');
    assert.match(sent[sent.length - 1], /質問と並べて見せた推測: （なし）/);

    const stored = JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8'));
    assert.deepEqual(stored.steps.map((s: Step) => s.inference?.status), ['accepted', 'revised', 'rejected']);
    assert.deepEqual(stored.steps[0].inference.basis, [past]);
  });

  it('先に推測し、推測で埋まらない点があれば質問に推測を添え、前の説明で足りれば確かめるだけにする', async () => {
    const sent: string[] = [];
    // 推測を見せられたら、欠損の判断は前の説明で足り、グラフの判断はまだ聞くことがあるとする
    const llm: PipelineLlm = {
      json: async <T>(messages: Message[]) => {
        const prompt = String((messages[0].content as unknown[])[0]);
        sent.push(prompt);
        const value = (
          prompt.includes('本人の過去の判断から推測する')
            ? prompt.includes('判断: 眺めた')
              ? { inferred_rationale: null, reasoning: '重ならない', basis: [] }
              : { inferred_rationale: '返品は売上に数えないため', reasoning: '同じ欠損の扱い', basis: ['p1'] }
            : prompt.includes('判断: 眺めた')
              ? { question: null, skip: '眺めただけ' }
              : prompt.includes('判断: グラフを分けた')
                ? { question: '店舗ごとに分けて見るのは、誰が何を判断するためですか？' }
                : { question: null, covered: '前の説明で足りる' }
        ) as T;
        return { value, raw: { text: JSON.stringify(value), model: 'fake', ms: 0 } };
      },
    };
    const p = new Pipeline({ dir: sessionDir(), prompts, llm, history: () => [past] });
    const summary = (decision: string) => ({ decision_and_actions: decision, rationale: '（理由は述べていない）', progression: '', knowledge: 'domain' as const });
    p.steps.push(
      questioned('st1', 1000, { question: undefined, summary: summary('欠損行を除いた') }),
      questioned('st2', 2000, { question: undefined, summary: summary('グラフを分けた') }),
      questioned('st3', 3000, { question: undefined, summary: summary('眺めた') }),
    );
    const asked = await p.askQuestions(p.steps);
    const [covered, ask, viewed] = p.steps;
    assert.deepEqual(asked.map((s) => s.id), ['st1', 'st2']);
    assert.equal(covered.question?.kind, 'confirm');
    assert.equal(covered.inference?.text, '返品は売上に数えないため');
    assert.equal(ask.question?.kind, 'ask');
    assert.equal(ask.inference?.status, 'open', '質問にも推測を添える');
    assert.equal(viewed.question, undefined);
    assert.equal(viewed.questionSkipped, '眺めただけ');
    const questionPrompts = sent.filter((s) => s.includes('理由を確認する質問を作る'));
    assert.match(questionPrompts[0], /## 前に説明した理由からの推測\n\n返品は売上に数えないため\n元にした判断: 返品の行を除いた → 返品は売上に数えないため/);
    assert.match(questionPrompts[1], /（前の説明からの推測「返品は売上に数えないため」が合っているかの確認）/, '確認だけの項目も、出したものとして見せる');
    assert.match(questionPrompts[2], /## 前に説明した理由からの推測\n\n（なし）/);
  });

  it('同じ記録の前のほうで話した理由で足りるなら、確かめるまでもないので何も出さない', async () => {
    const llm: PipelineLlm = {
      json: async <T>(messages: Message[]) => {
        const prompt = String((messages[0].content as unknown[])[0]);
        const value = (prompt.includes('本人の過去の判断から推測する') ? { inferred_rationale: '返品は売上に数えないため', reasoning: '', basis: ['p1'] } : { question: null, covered: '足りる' }) as T;
        return { value, raw: { text: JSON.stringify(value), model: 'fake', ms: 0 } };
      },
    };
    const p = new Pipeline({ dir: sessionDir(), prompts, llm });
    p.steps.push(justified('st1', 1000, '返品は売上に数えないため'), questioned('st2', 5000, { question: undefined }));
    assert.equal((await p.askQuestions(p.steps)).length, 0);
    assert.equal(p.steps[1].questionSkipped, 'この記録の前のほうで説明している（st1）');
    assert.equal(p.steps[1].inference, undefined);
  });

  it('記録中も、質問を出すときには推測が添えてある', async () => {
    const changes: string[] = [];
    const l = new LivePipeline({
      dir: sessionDir(),
      prompts,
      llm: fakeLlm([]),
      history: () => [past],
      onChange: () => changes.push(l.pipeline.steps.map((s) => `${s.question ? 'Q' : '-'}${s.inference ? 'I' : '-'}`).join()),
    });
    l.addUtterance({ start: 1000, end: 2000, text: '欠損があるな。' });
    l.addAction(edit);
    const p = await l.finish();
    assert.equal(p.steps[0].inference?.text, '欠損は返品なので売上に数えないため');
    assert.equal(changes[0], 'QI');
  });
});

describe('中身を見ただけの確認', () => {
  it('質問はしない。合流して確認だけになったら、出していた質問を取り下げる', async () => {
    const sent: string[] = [];
    const p = new Pipeline({ dir: sessionDir(), prompts, llm: spy(fakeLlm([]), sent) });
    const summary = { decision_and_actions: 'store 列の value_counts を見た', rationale: '（理由は述べていない）', progression: '', knowledge: 'domain' as const, step_type: 'check' as const };
    const check = questioned('st1', 1000, { question: undefined, evaluation: undefined, summary });
    const merged = questioned('st2', 2000, { summary });
    p.steps.push(check, merged);
    await p.evaluate(p.steps);
    assert.equal(check.evaluation?.level, 'empty');
    assert.equal(merged.question?.status, 'dismissed');
    const evaluated = sent.length;
    assert.equal((await p.askQuestions(p.steps)).length, 0);
    assert.equal(sent.length, evaluated, '質問のための LLM は呼ばない');
  });

  it('見て気づいたことを説明していれば、過去の説明として後の推測に使う', async () => {
    const sent: string[] = [];
    const p = new Pipeline({ dir: sessionDir(), prompts, llm: spy(fakeLlm([]), sent) });
    const noticed = justified('st1', 1000, '吉祥寺は 8 月開店のため件数が少ない');
    noticed.summary!.step_type = 'check';
    p.steps.push(noticed, questioned('st2', 5000, { question: undefined }));
    await p.infer([p.steps[1]]);
    assert.match(sent[0], /理由: 吉祥寺は 8 月開店のため件数が少ない/);
  });
});

describe('推測に見せる過去の判断の選び方', () => {
  it('多すぎるときは、直近のものと、今の判断と語が重なるものを選ぶ（古い順）', () => {
    const decision = (i: number, d: string, r: string): PastDecision => ({ session: 's', step: `st${i}`, at: i, decision: d, rationale: r });
    const past = [
      decision(0, 'quantity の欠損行を drop_nulls で除いた', '欠損はレジの手入力の漏れで、数が少ないので無視するため'),
      ...Array.from({ length: 30 }, (_, i) => decision(i + 1, `店舗別の棒グラフを描いた ${i}`, '店舗間で売上を比べたいため')),
      decision(31, '日付で集計した', '日ごとの傾向を見るため'),
    ];
    const picked = selectPast('欠損があるので drop_nulls で落とした', past, 5, 2);
    assert.equal(picked.length, 5);
    assert.deepEqual(picked[0], past[0], '古くても重なる説明は拾う');
    assert.deepEqual(picked.slice(-2), past.slice(-2), '直近のものは必ず入れる');
    assert.deepEqual(picked.map((d) => d.at), [...picked.map((d) => d.at)].sort((a, b) => a - b));
    assert.deepEqual(selectPast('なんでも', past.slice(0, 3), 5), past.slice(0, 3), '少なければ全部');
  });
});

describe('前の記録の判断', () => {
  it('この記録より前に始めた記録から、理由がはっきりした業務・データ固有の判断だけ集める', () => {
    const root = mkdtempSync(join(tmpdir(), 'clearfairy-sessions-'));
    const session = (name: string, startedAt: number, steps: Step[]) => {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'session.json'), JSON.stringify({ startedAt }));
      writeFileSync(join(root, name, 'steps.json'), JSON.stringify({ steps }));
    };
    session('a', 100, [
      justified('st1', 110, '返品は売上に数えないため'),
      justified('st2', 120, 'メモリを空けるため', 'general'),
      questioned('st3', 130),
      questioned('st4', 140, {
        summary: { decision_and_actions: '欠損行を除いた', rationale: 'レジの入力漏れなので除くため', progression: '', knowledge: 'domain' },
        question: { id: 'q1', text: '？', status: 'answered', createdAt: 0, answer: { text: 'レジの入力漏れ', via: 'voice', at: 0 } },
      }),
    ]);
    session('b', 200, []);
    session('c', 300, [justified('st1', 310, '後の記録の理由')]);
    assert.deepEqual(
      loadHistory(root, join(root, 'b')).map((d) => [d.session, d.step, d.rationale]),
      [
        ['a', 'st1', '返品は売上に数えないため'],
        ['a', 'st4', 'レジの入力漏れなので除くため'],
      ],
    );
  });
});

// 特定のプロンプトだけ times 回失敗する
const failing = (llm: PipelineLlm, keyword: string, times = Infinity): PipelineLlm => {
  let failed = 0;
  return {
    json: <T>(messages: Message[]) => {
      if (String((messages[0].content as unknown[])[0]).includes(keyword) && failed < times) {
        failed++;
        return Promise.reject(new Error('一時的な失敗'));
      }
      return llm.json<T>(messages);
    },
  };
};

// 発話を前のステップの続きとして割り当てる
const assigningLeft = (llm: PipelineLlm): PipelineLlm => ({
  json: <T>(messages: Message[]) => {
    const prompt = String((messages[0].content as unknown[])[0]);
    if (!prompt.includes('前後どちらのまとまり')) return llm.json<T>(messages);
    const value = { assignments: [...prompt.matchAll(/対象 (G\d+)/g)].map((m) => ({ group: m[1], direction: 'left' })) } as T;
    return Promise.resolve({ value, raw: { text: JSON.stringify(value), model: 'fake', ms: 0 } });
  },
});

const storedSteps = (dir: string): Step[] => JSON.parse(readFileSync(join(dir, 'steps.json'), 'utf8')).steps;

describe('回答の反映', () => {
  it('答えた後に次の区切りの発話が合流しても、回答を反映した理由を残す', async () => {
    const p = new Pipeline({ dir: sessionDir(), prompts, llm: assigningLeft(fakeLlm([])) });
    const first = toSentences([{ start: 1000, end: 2000, text: '欠損があるな。' }]);
    p.sentences.push(...first);
    const { added } = await p.addWindow({ t0: 1000, t1: 5000, sentences: first, actions: [edit] });
    await p.analyze(added);
    await p.answer(added[0].id, '欠損は返品なので売上に数えない', 'voice');
    assert.equal(added[0].summary?.rationale, '欠損は返品なので売上に数えないため');

    const next = toSentences([{ start: 6000, end: 7000, text: '続きを話す。' }], first.length);
    p.sentences.push(...next);
    const { changed } = await p.addWindow({ t0: 6000, t1: 7000, sentences: next, actions: [] });
    assert.deepEqual(changed, added, '前のステップに合流すること');
    await p.analyze(changed);
    assert.equal(added[0].summary?.rationale, '欠損は返品なので売上に数えないため');
    assert.equal(isJustified(added[0]), true, '推測の元からも外れないこと');
  });

  it('記録を止めた後に同じ記録の質問へ続けて答えても、どちらの回答も残る', async () => {
    const dir = sessionDir();
    writeFileSync(join(dir, 'actions.jsonl'), JSON.stringify(edit) + '\n');
    const options = { dir, prompts, llm: fakeLlm([]) };
    const p = new Pipeline(options);
    p.steps.push(questioned('st1', 1000), questioned('st2', 2000));
    p.save();
    const target = new SavedAnswers(() => options).target(dir);
    await Promise.all([target.answer('st1', '返品なので数えない', 'text'), target.answer('st2', '廃棄なので数えない', 'text')]);
    assert.deepEqual(
      storedSteps(dir).map((s) => s.question?.answer?.text),
      ['返品なので数えない', '廃棄なので数えない'],
    );
  });

  it('回答の反映に失敗したら未回答のままで、もう一度送れる', async () => {
    const dir = sessionDir();
    const past: PastDecision = { session: 's', step: 'st1', at: 0, decision: '返品の行を除いた', rationale: '返品は売上に数えないため' };
    const p = new Pipeline({ dir, prompts, llm: failing(fakeLlm([]), '回答も踏まえて', 1), retryDelaysMs: [], history: () => [past] });
    p.steps.push(questioned('st1', 1000));
    await p.infer(p.steps);
    p.save();
    await assert.rejects(p.answer('st1', '返品なので数えない', 'text'));
    const step = p.steps[0];
    assert.equal(step.question?.status, 'open');
    assert.equal(step.question?.answer, undefined);
    assert.equal(step.inference?.status, 'open');
    assert.equal(storedSteps(dir)[0].question?.status, 'open');

    await p.answer('st1', '返品なので数えない', 'text');
    assert.equal(step.question?.status, 'answered');
    assert.equal(step.inference?.status, 'revised');
  });
});

describe('LLM の失敗', () => {
  const sentenceAndEdit = (live: LivePipeline) => {
    live.addUtterance({ start: 1000, end: 2000, text: '欠損があるな。' });
    live.addAction(edit);
  };

  it('一時的に失敗したら、少し待ってやり直す', async () => {
    const p = new Pipeline({ dir: sessionDir(), prompts, llm: failing(fakeLlm([]), '意思決定ステップを要約する', 1), retryDelaysMs: [0] });
    const sentences = toSentences([{ start: 1000, end: 2000, text: '欠損があるな。' }]);
    p.sentences.push(...sentences);
    const { added } = await p.addWindow({ t0: 1000, t1: 5000, sentences, actions: [edit] });
    await p.analyze(added);
    assert.ok(added[0].summary);
  });

  it('要約に失敗したステップは残し、後でやり直す', async () => {
    const dir = sessionDir();
    const failures: string[] = [];
    const live = new LivePipeline({ dir, prompts, llm: failing(fakeLlm([]), '意思決定ステップを要約する', 1), retryDelaysMs: [], onFailure: (m) => failures.push(m) });
    sentenceAndEdit(live);
    const p = await live.finish();
    assert.deepEqual(failures, ['一時的な失敗']);
    assert.equal(p.steps.length, 1);
    assert.ok(p.steps[0].summary, '要約が作り直されること');
    assert.ok(p.steps[0].question, '質問まで進むこと');
    assert.equal(live.unprocessed, 0);
    assert.ok(storedSteps(dir)[0].summary);
  });

  it('ステップを作る前に失敗したら、発話と操作を戻してやり直す', async () => {
    const live = new LivePipeline({ dir: sessionDir(), prompts, llm: failing(fakeLlm([]), '密接に関連する文のまとまり', 1), retryDelaysMs: [] });
    sentenceAndEdit(live);
    const p = await live.finish();
    assert.equal(p.steps.length, 1);
    assert.equal(p.steps[0].sentences.length, 1);
    assert.equal(p.steps[0].actionGroups.length, 1);
    assert.equal(live.unprocessed, 0);
  });

  it('失敗が続いたら、処理しきれなかった分を数えて知らせる', async () => {
    const failures: string[] = [];
    const live = new LivePipeline({ dir: sessionDir(), prompts, llm: failing(fakeLlm([]), '文字起こしを校正する'), retryDelaysMs: [], onFailure: (m) => failures.push(m) });
    sentenceAndEdit(live);
    const p = await live.finish();
    assert.equal(p.steps.length, 0);
    assert.equal(live.unprocessed, 2);
    assert.equal(failures.length, 2);
  });

  it('記録中に失敗したら、しばらくは呼び直さない', async () => {
    mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
    try {
      let calls = 0;
      const llm: PipelineLlm = {
        json: () => {
          calls++;
          return Promise.reject(new Error('一時的な失敗'));
        },
      };
      const live = new LivePipeline({ dir: sessionDir(), prompts, llm, retryDelaysMs: [] });
      live.addUtterance({ start: 0, end: 1000, text: '欠損があるな。' });
      const advance = async (ms: number) => {
        for (let i = 0; i < ms / 1000; i++) {
          mock.timers.tick(1000);
          for (let j = 0; j < 20; j++) await new Promise((r) => setImmediate(r));
        }
      };
      await advance(18_000);
      assert.equal(calls, 1, '15 秒なにも起きないと区切る');
      await advance(20_000);
      assert.equal(calls, 1, 'すぐには呼び直さない');
      await advance(15_000);
      assert.equal(calls, 2, '少したつとやり直す');
      await live.finish();
    } finally {
      mock.timers.reset();
    }
  });
});
