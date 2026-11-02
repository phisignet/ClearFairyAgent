# ClearFairy for VS Code

作業しながら口に出した独り言（思考発話）と、VS Code 上の操作（Python の `.py` と Jupyter の `.ipynb`）から、コーディング中の判断とその理由を「意思決定ステップ」として記録する拡張機能。仕様はおおむね論文 ClearFairy（CHI 2026、[arXiv:2509.14537](https://arxiv.org/abs/2509.14537)）に従う。

- 音声認識はローカル（CPU）。sherpa-onnx の Whisper turbo を使う
- 言語モデルは Copilot の言語モデル API（`vscode.lm`）を使う
- 記録するのは手で書いたコードだけ。AI エージェント（Claude Code、Copilot のエージェントなど）の編集は除く

## 使い方（Phase 1 の途中）

1. ステータスバーの「🎤 ClearFairy」で作業の記録を始め、もう一度押すと止める
2. 止めると、記録から意思決定ステップ（判断・理由・経緯）を自動で作る（20 分の記録で 4 分ほど）。終わったら「記録を見る」で開ける
3. 後から見るときはコマンド「ClearFairy: 記録を見る」、作り直すときは「ClearFairy: 記録から意思決定ステップを作り直す」

記録はワークスペースの `.clearfairy/sessions/<日時>/` に残る（`.clearfairy/` は git に載らない）。

| ファイル | 中身 |
|---|---|
| `session.json` | 概要（開始・終了、モデル、マイク、件数） |
| `utterances.jsonl` | 発話ごとの文字起こし（実時刻付き） |
| `actions.jsonl` | 操作（編集・閲覧・セル実行・ターミナル・デバッグ・エラー表示）。型は `src/capture/actions.ts` |
| `events.jsonl` | 生のイベント（操作のまとめ方を見直すとき用） |
| `images/` | セルの画像出力 |
| `audio.wav` | 録音（設定 `clearfairy.speech.keepAudio`） |
| `sentences.json` | 文に分けて補正した文字起こし（補正前の文と、除いた雑音の印付き） |
| `steps.json` | 意思決定ステップ（判断・理由・経緯と、結び付いた発話・操作） |
| `pipeline/` | ステップを作るときの LLM との入出力（プロンプトの調整用） |

## 開発

```sh
npm install
npm run build        # dist/ に束ねる（npm run watch で監視）
npm test             # テスト用の VS Code を別に起動して統合テスト（ログインはしていない）
npm run test:unit    # vscode に依存しない処理の単体テスト
bash scripts/download-models.sh sherpa-onnx-whisper-turbo sherpa-onnx-zipformer-ja-en-reazonspeech-2025-01-17
```

- **Ctrl+Shift+B**（タスク「開発ホストを開く」）で、ビルドしてから `spike/playground` を開いた開発ホストが立ち上がる。VS Code 1.144 では F5（デバッガ付き）で開くと拡張機能のプロセスが起動直後に落ちる（終了コード 134）ので、デバッガは付けない。playground では音声認識モデルにリポジトリの `.cache/models` を使う（`spike/playground/.vscode/settings.json`）
- Copilot の言語モデルはサインイン済みの VS Code の中でしか呼べないので、開発ホストに外から依頼を出せるようにしてある（`src/dev/jobs.ts`、開発ホストでだけ有効）

  ```sh
  node scripts/dev-job.mjs '{"type":"ping"}'
  node scripts/dev-job.mjs '{"type":"llm","messages":[{"role":"user","content":"こんにちは"}]}'
  node scripts/dev-job.mjs '{"type":"reload"}'   # 新しいビルドを読み込み直す（記録中は断る）
  node scripts/dev-job.mjs '{"type":"pipeline","session":"<日時>"}' --timeout 1500   # 記録からステップを作り直す
  node scripts/dev-job.mjs '{"type":"openSession","session":"<日時>"}'
  ```

- `spike/` は Phase 0（技術検証）のスクリプトと結果。詳しくは `spike/README.md`

## 構成

| ディレクトリ | 中身 |
|---|---|
| `src/speech/` | 録音・VAD・音声認識の子プロセス（`worker.ts`）と、その呼び出し・モデルの取得 |
| `src/capture/` | 操作のまとめ（`actionRecorder.ts`）と生のイベント（`eventLog.ts`） |
| `src/session/` | 作業セッション（録音と操作の記録を同時に開始・停止して保存） |
| `src/llm/` | Copilot の言語モデル |
| `src/pipeline/` | 記録から意思決定ステップを作る処理（論文の CLEAR と要約）。流れは `run.ts` の先頭のコメント |
| `prompts/` | LLM へのプロンプト（毎回ファイルから読むので、拡張機能を読み込み直さずに調整できる） |
| `src/ui/` | ステータスバーのボタン、記録を見る画面 |
| `src/dev/` | 開発用の依頼の受け口 |
| `src/spike/` | Phase 0 の検証用コマンド（手順ページ） |
| `test/` | 統合テスト |
