// sherpa-onnx の音声認識モデルの設定を、モデルのディレクトリのファイル構成から組み立てる。
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export type AsrModelKind =
  | 'moonshine'
  | 'qwen3-asr'
  | 'sense-voice'
  | 'whisper'
  | 'cohere'
  | 'nemotron'
  | 'transducer'
  | 'nemo-transducer'
  | 'nemo-ctc';

export interface AsrModel {
  kind: AsrModelKind;
  // true なら OnlineRecognizer（ストリーミング用のモデル）を使う
  streaming: boolean;
  // sherpa-onnx の Recognizer に渡す設定
  recognizerConfig: Record<string, unknown>;
  // stream.setOption で渡す設定（言語の指定など）
  streamOptions: Record<string, string>;
}

export const SAMPLE_RATE = 16000;

export function asrModel(dir: string, numThreads: number, hotwords = ''): AsrModel {
  const files = readdirSync(dir);
  const has = (name: string) => files.includes(name);
  const pick = (re: RegExp) => {
    const found = files.filter((f) => re.test(f));
    // int8 > fp32 > fp16 の順に選ぶ（CPU では int8 が速く、fp16 は変換が挟まる）
    const file = found.find((f) => f.includes('int8')) ?? found.find((f) => !f.includes('fp16')) ?? found[0];
    if (!file) throw new Error(`${dir} に ${re} が無い`);
    return join(dir, file);
  };
  const base = { tokens: join(dir, 'tokens.txt'), numThreads, provider: 'cpu', debug: 0 };
  const config = (kind: AsrModelKind, modelConfig: Record<string, unknown>, extra: { streaming?: boolean; featureDim?: number; streamOptions?: Record<string, string> } = {}): AsrModel => ({
    kind,
    streaming: extra.streaming ?? false,
    recognizerConfig: { featConfig: { sampleRate: SAMPLE_RATE, featureDim: extra.featureDim ?? 80 }, modelConfig },
    streamOptions: extra.streamOptions ?? {},
  });
  const transducer = () => ({ encoder: pick(/^encoder.*\.onnx$/), decoder: pick(/^decoder.*\.onnx$/), joiner: pick(/^joiner.*\.onnx$/) });

  if (has('encoder_model.ort') && has('decoder_model_merged.ort')) {
    return config('moonshine', { ...base, moonshine: { encoder: join(dir, 'encoder_model.ort'), mergedDecoder: join(dir, 'decoder_model_merged.ort') } });
  }
  if (has('conv_frontend.onnx')) {
    return config('qwen3-asr', {
      ...base,
      tokens: '',
      qwen3Asr: { convFrontend: join(dir, 'conv_frontend.onnx'), encoder: pick(/^encoder.*\.onnx$/), decoder: pick(/^decoder.*\.onnx$/), tokenizer: join(dir, 'tokenizer'), hotwords },
    });
  }
  if (dir.includes('whisper')) {
    // ファイル名は <名前>-encoder.int8.onnx / <名前>-decoder.int8.onnx / <名前>-tokens.txt
    return config('whisper', {
      ...base,
      tokens: pick(/-tokens\.txt$/),
      whisper: { encoder: pick(/-encoder.*\.onnx$/), decoder: pick(/-decoder.*\.onnx$/), language: 'ja', task: 'transcribe', tailPaddings: -1 },
    });
  }
  if (dir.includes('cohere-transcribe')) {
    return config('cohere', { ...base, cohereTranscribe: { encoder: pick(/^encoder.*\.onnx$/), decoder: pick(/^decoder.*\.onnx$/), usePunct: 1, useItn: 1 } }, { streamOptions: { language: 'ja' } });
  }
  if (dir.includes('nemotron')) {
    // VS Code の組み込みディクテーションと同じ系統のストリーミング用モデル。特徴量は 128 次元
    return config('nemotron', { ...base, transducer: transducer() }, { streaming: true, featureDim: 128, streamOptions: { language: 'ja' } });
  }
  if (dir.includes('sense-voice')) {
    // 自動判定だと日本語が中国語と判定されることがあるので、言語を固定する
    return config('sense-voice', { ...base, senseVoice: { model: pick(/^model.*\.onnx$/), language: 'ja', useInverseTextNormalization: 1 } });
  }
  if (files.some((f) => /^encoder.*\.onnx$/.test(f)) && files.some((f) => /^joiner.*\.onnx$/.test(f))) {
    return dir.includes('nemo')
      ? config('nemo-transducer', { ...base, modelType: 'nemo_transducer', transducer: transducer() })
      : config('transducer', { ...base, transducer: transducer() });
  }
  if (dir.includes('nemo') && files.some((f) => /^model.*\.onnx$/.test(f))) {
    return config('nemo-ctc', { ...base, nemoCtc: { model: pick(/^model.*\.onnx$/) } });
  }
  throw new Error(`モデルの種類を判定できない: ${dir}（${files.join(', ')}）`);
}

// sherpa-onnx-node は型定義を持たないので、使う部分だけを書いておく
interface Stream {
  acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void;
  setOption(key: string, value: string): void;
  inputFinished?(): void;
}
interface Recognizer {
  createStream(): Stream;
  decode(stream: Stream): void;
  isReady?(stream: Stream): boolean;
  getResult(stream: Stream): { text: string };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createRecognizer(sherpa: any, model: AsrModel): Recognizer {
  return model.streaming ? new sherpa.OnlineRecognizer(model.recognizerConfig) : new sherpa.OfflineRecognizer(model.recognizerConfig);
}

// 区間 1 つ分の音声を認識する。ストリーミング用のモデルは、末尾に無音を足して入力の終わりを伝えてから回す。
// 無音が処理単位（1120ms 版なら 1.12 秒）より短いと、最後の言葉が出てこないので長めに足す
const STREAMING_TAIL_SECONDS = 1.5;

export function recognize(recognizer: Recognizer, model: AsrModel, samples: Float32Array): string {
  const stream = recognizer.createStream();
  for (const [key, value] of Object.entries(model.streamOptions)) stream.setOption(key, value);
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  if (model.streaming) {
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: new Float32Array(Math.round(SAMPLE_RATE * STREAMING_TAIL_SECONDS)) });
    stream.inputFinished?.();
    while (recognizer.isReady?.(stream)) recognizer.decode(stream);
  } else {
    recognizer.decode(stream);
  }
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
