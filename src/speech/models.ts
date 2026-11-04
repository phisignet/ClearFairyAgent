// sherpa-onnx の音声認識モデルの設定を、モデルのディレクトリのファイル構成から組み立てる。
// 対応するのは設定で選べる 2 種類（Whisper と zipformer の Transducer）。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const SAMPLE_RATE = 16000;

// sherpa-onnx の OfflineRecognizer に渡す設定
export function recognizerConfig(dir: string, numThreads: number): Record<string, unknown> {
  const files = readdirSync(dir);
  const pick = (re: RegExp) => {
    const found = files.filter((f) => re.test(f));
    // int8 > fp32 > fp16 の順に選ぶ（CPU では int8 が速く、fp16 は変換が挟まる）
    const file = found.find((f) => f.includes('int8')) ?? found.find((f) => !f.includes('fp16')) ?? found[0];
    if (!file) throw new Error(`${dir} に ${re} が無い`);
    return join(dir, file);
  };
  const base = { numThreads, provider: 'cpu', debug: 0 };
  const modelConfig = dir.includes('whisper')
    ? // ファイル名は <名前>-encoder.int8.onnx / <名前>-decoder.int8.onnx / <名前>-tokens.txt
      { ...base, tokens: pick(/-tokens\.txt$/), whisper: { encoder: pick(/-encoder.*\.onnx$/), decoder: pick(/-decoder.*\.onnx$/), language: 'ja', task: 'transcribe', tailPaddings: -1 } }
    : { ...base, tokens: join(dir, 'tokens.txt'), transducer: { encoder: pick(/^encoder.*\.onnx$/), decoder: pick(/^decoder.*\.onnx$/), joiner: pick(/^joiner.*\.onnx$/) } };
  return { featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, modelConfig };
}

// sherpa-onnx-node は型定義を持たないので、使う部分だけを書いておく
interface Stream {
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
}
export interface Recognizer {
  createStream(): Stream;
  decode(stream: Stream): void;
  getResult(stream: Stream): { text: string };
}

// 区間 1 つ分の音声を認識する
export function recognize(recognizer: Recognizer, samples: Float32Array): string {
  const stream = recognizer.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  recognizer.decode(stream);
  return recognizer.getResult(stream).text.trim();
}

export function vadConfig(model: string) {
  return {
    sileroVad: { model, threshold: 0.5, minSpeechDuration: 0.25, minSilenceDuration: 0.5, maxSpeechDuration: 15, windowSize: 512 },
    sampleRate: SAMPLE_RATE,
    debug: false,
    numThreads: 1,
  };
}
