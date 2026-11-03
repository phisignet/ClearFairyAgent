---
name: clearfairy-records
description: ClearFairy for VS Code の作業記録（ワークスペースの .clearfairy/sessions/）の読み方。過去の作業で何を判断したか、なぜそうしたか、本人が確かめた業務・データ固有の理由はどれかを調べるときに使う。
---

# ClearFairy の作業記録の読み方

ClearFairy は、コーディング中の独り言と VS Code の操作から、判断とその理由を「意思決定ステップ」として記録する。この文書は、その記録の読み方だけを説明する。

記録は読むだけにして、書き換えない。質問への回答や推測の確かめは、本人が VS Code の画面で行う。

## 記録の場所

記録はワークスペース（複数あれば 1 番目のフォルダ）の `.clearfairy/sessions/<YYYYMMDD-HHMMSS>/` に、作業ごとに 1 フォルダある。フォルダ名は記録を始めたときの現地時刻で、名前順に並べると古い順になる。

`.clearfairy/` は git の対象外なので、検索ツールが飛ばすことがある。見つからなくても「記録が無い」と判断せず、`.clearfairy/sessions/` を一覧してファイルを直接開く。

別のワークスペースの記録はここには無い。`.clearfairy/` の `dev/` など、`sessions/` の外は開発用なので読まない。

## 読む順番

1. `.clearfairy/sessions/` を一覧し、対象の記録を決める。指定が無ければ新しいものから見る
2. その記録の `steps.json` を読む。`tasks` で作業の流れをつかみ、必要な `steps` を詳しく見る
3. 発話や操作の詳細が要るときだけ、`sentences` と `actions.jsonl` を見る

| 知りたいこと | 見るところ |
|---|---|
| その回の作業で何をしたか | `tasks` の `title` と `summary` |
| ある列・関数・値をなぜそう扱ったか | 各記録の `steps[].summary` で、その語を含むステップ |
| 業務・データについて本人が説明したこと | 下の「信頼できる理由」に当てはまるステップ |

`steps.json` が無いか `steps` が空なら、ステップはまだ作られていない（または作れなかった）。そのときは `utterances.jsonl` と `actions.jsonl` を直接読む。`session.json` に `endedAt` が無ければ記録中か途中で止まった記録で、`steps.json` は途中までしかない。

## steps.json

`tasks` は小作業のまとまりで、`steps` にステップの `id` が入っている。時刻（`t0`、`t1`、`at` など）はすべてエポックミリ秒。

`steps` の各ステップの項目は次のとおり。無い項目は、その処理の対象ではなかったか、まだ行われていない。

| 項目 | 意味 |
|---|---|
| `kind` | `linked`: 発話と操作がある / `talk`: 発話だけ / `action-only`: 説明の無い操作だけ |
| `summary.decision_and_actions` | 判断と、行った操作 |
| `summary.rationale` | 判断の理由。本人が話したことと、質問への回答から作る。`（理由は述べていない）` なら理由は無い |
| `summary.progression` | 前後の作業とのつながり |
| `summary.knowledge` | `domain`: 業務・データ固有 / `general`: 一般的なコーディング |
| `summary.step_type` | `decision`: 扱い方・処理・見せ方を選んだ / `check`: 中身を見ただけで、何も選んでいない。無ければ `decision` |
| `evaluation` | 理由の評価。`domain` のステップだけにある。`level` は `strong`（十分）/ `weak`（浅い）/ `empty`（説明なし）、`reason` はその根拠 |
| `question` | 本人への質問。`status` は `open`（未回答）/ `answered`（回答済み）/ `dismissed`（答えなかった、または不要になった。画面にはもう出ない） |
| `question.answer` | 本人の回答。`text` が内容、`via` は `text` / `voice` / `inference`（推測を「合っている」と認めた） |
| `questionSkipped` | 質問を作らなかったときの理由。今の状態ではない（下の「それ以外の読み方」を参照） |
| `inference` | 過去の判断から LLM が推測した理由。`text` が内容、`basis` が元にした判断、`status` は下の表のとおり |
| `sentences` | このステップの発話。`text` が補正後、`original` が補正前（補正したときだけある） |
| `actionGroups` | このステップの操作のまとまり。`actions` の id は `actions.jsonl` の `id` に対応する |

## 信頼できる理由

本人の理由として扱ってよいのは、次のすべてに当てはまるステップの `summary.rationale` だけ。

- `summary.knowledge` が `domain`
- `evaluation.level` が `strong`、または `question.status` が `answered`
- `summary.rationale` に `（理由は述べていない）` を含まない

`evaluation.level` はステップ全体の評価で、`rationale` のすべてが十分とは限らない。`categories` に `S-` と `W-` が混ざっているときは、`evaluation.reason` で何が十分とされたかを確かめる。十分とされた説明が `rationale` ではなく `progression` や `sentences` にあることもある。

それ以外の読み方は次のとおり。

- `evaluation.level` が `weak` か `empty` で未回答のステップは、理由がはっきりしていない。本人の理由として断定しない
- `questionSkipped` に「質問済みで未回答」とあっても、その後に答えられたか、取り下げられていることがある。前のステップの `question.status` を確かめる。言い回しが違うことがあるので、語で探さず `question` のあるステップを順に見る
- `step_type` が `check` のステップは判断ではなく観察。理由があっても「こう決めた」とは書かない。「〜だからか」のような推量も含むので、本人の見立てとして扱う
- `general` のステップは一般的なコーディングの話で、業務・データの知識としては扱わない

`inference` は LLM の推測なので、`status` で扱いを分ける。

| `status` | 意味 | 扱い |
|---|---|---|
| `accepted` | 本人が「合っている」と認めた | 本人の理由として扱う |
| `revised` | 本人が推測を見て自分の言葉で答えた | `question.answer.text` を本人の理由とする。推測の `text` は使わない |
| `open` | 本人がまだ確かめていない | 推測であることを明示する。本人の理由としない |
| `rejected` | 本人が違うと言った | 使わない |

## 読むときの注意

- `summary` は発話と操作を LLM が要約したもの。言い回しや細部を確かめるときは `sentences` と `actions.jsonl` を見る
- 文字起こしには聞き違いが残る。店名や列名などは、`actions.jsonl` のコードやセルの出力の表記を正とする
- 記録は当時の判断で、今のコードと同じとは限らない。同じ論点で食い違うときは、時刻の新しいほうを優先し、今のコードも確かめる
- 記録されるのは手で書いたコードだけで、AI エージェントの編集は入らない

## その他のファイル

記録のフォルダには次のファイルもある。

| ファイル | 中身 |
|---|---|
| `session.json` | 概要。開始・終了の時刻、マイク、発話と操作の件数 |
| `sentences.json` | 文に分けて補正した文字起こしの全文。`noise` が付いた文は雑音として除いたもの |
| `utterances.jsonl` | 発話ごとの文字起こし（補正前）。`start`、`end`、`text` |
| `actions.jsonl` | 操作。`kind` は `edit`（`diff`）、`view`、`cell-run`（`source`、`outputs`）、`terminal`（`command`、`output`）、`debug`、`diagnostics` |
| `images/` | セルの画像出力。`actions.jsonl` の `outputs[].image` がこの記録のフォルダからの相対パス |
| `answers.jsonl` | 音声の回答の文字起こし。本人が直す前のものなので、回答は `question.answer.text` を見る |

`events.jsonl`（生のイベント）、`pipeline/`（LLM との入出力）、`audio.wav`（録音）は、記録を読むだけなら開かなくてよい。
