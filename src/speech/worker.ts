// 音声ワーカー（子プロセス）: 録音 → VAD で発話を切り出す → 音声認識、を回し、
// 発話ごとの文字起こしを親（拡張機能）に送る。
// 拡張機能のプロセスと分けるのは、sherpa-onnx の decode() が同期処理でイベントループを止めるのと、
// ネイティブモジュールが異常終了しても拡張機能を巻き込まないため。
import { closeSync, openSync, writeSync } from 'node:fs';
import { asrModel, createRecognizer, recognize, SAMPLE_RATE, vadConfig, type AsrModel } from './models';
import type { FromWorker, ProbeResult, RecorderKind, StartOptions, ToWorker } from './protocol';

/* eslint-disable @typescript-eslint/no-require-imports */
const load = {
  sherpa: () => require('sherpa-onnx-node'),
  decibri: () => require('decibri'),
  pvrecorder: () => require('@picovoice/pvrecorder-node'),
};

const VAD_WINDOW = 512;
const RING_SECONDS = 60;
const LEVEL_INTERVAL_MS = 250;
// Electron は外部バッファ（ネイティブ側のメモリをそのまま見せる配列）を禁止しているので、
// sherpa-onnx から配列を受け取る関数には false を渡してコピーさせる
const EXTERNAL_BUFFER = false;

function send(msg: FromWorker): Promise<void> {
  return new Promise((resolve) => (process.send ? process.send(msg, () => resolve()) : resolve()));
}

const errorText = (e: unknown) => (e instanceof Error ? (e.stack ?? e.message) : String(e));

// ---- 録音 ----

interface Recorder {
  device: string;
  stop(): void;
}

function openRecorder(options: StartOptions, onPcm: (pcm: Int16Array) => void, onError: (e: unknown) => void): Recorder {
  const kind: RecorderKind = options.recorder;
  if (kind === 'file') {
    const wave: { sampleRate: number; samples: Float32Array } = load.sherpa().readWave(options.inputWav, EXTERNAL_BUFFER);
    if (wave.sampleRate !== SAMPLE_RATE) throw new Error(`${options.inputWav} は ${wave.sampleRate}Hz（${SAMPLE_RATE}Hz を想定）`);
    // タイマーの精度に左右されないよう、一定間隔ごとに「速度 × 間隔」分のサンプルをまとめて流す
    const tickMs = 100;
    const perTick = Math.round((SAMPLE_RATE * tickMs * (options.speed ?? 1)) / 1000);
    let offset = 0;
    const timer = setInterval(() => {
      const frame = wave.samples.subarray(offset, offset + perTick);
      offset += perTick;
      onPcm(Int16Array.from(frame, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32768)))));
      if (offset >= wave.samples.length) {
        clearInterval(timer);
        void send({ type: 'inputEnded' });
      }
    }, tickMs);
    return { device: `file:${options.inputWav}`, stop: () => clearInterval(timer) };
  }
  if (kind === 'pvrecorder') {
    const { PvRecorder } = load.pvrecorder();
    const recorder = new PvRecorder(VAD_WINDOW, -1);
    let running = true;
    recorder.start();
    void (async () => {
      try {
        while (running) onPcm(await recorder.read());
      } catch (e) {
        if (running) onError(e);
      } finally {
        recorder.release();
      }
    })();
    return {
      device: recorder.getSelectedDevice(),
      stop: () => {
        running = false;
        recorder.stop();
      },
    };
  }

  const { Microphone, inputDevices } = load.decibri();
  const devices: { name: string; isDefault: boolean }[] = inputDevices();
  const mic = new Microphone({ sampleRate: SAMPLE_RATE, channels: 1 });
  mic.on('data', (chunk: Buffer) => onPcm(new Int16Array(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length))));
  mic.on('error', onError);
  return { device: (devices.find((d) => d.isDefault) ?? devices[0])?.name ?? '(不明)', stop: () => mic.stop() };
}

// ---- 余白付きで区間を切り出すための、直近の音声のリングバッファ ----

class Ring {
  private readonly buf: Float32Array;
  total = 0; // これまでに書き込んだサンプル数

  constructor(size: number) {
    this.buf = new Float32Array(size);
  }

  push(x: Float32Array): void {
    const size = this.buf.length;
    for (let i = 0; i < x.length; i++) this.buf[(this.total + i) % size] = x[i];
    this.total += x.length;
  }

  slice(from: number, to: number): Float32Array {
    from = Math.max(from, this.total - this.buf.length, 0);
    to = Math.min(to, this.total);
    const out = new Float32Array(Math.max(0, to - from));
    for (let i = 0; i < out.length; i++) out[i] = this.buf[(from + i) % this.buf.length];
    return out;
  }
}

// 声の大きさに合わせて、VAD と認識に渡す前に増幅する。声が小さいと VAD が話し始めに気づくのが遅れ、
// 語頭が欠ける（Phase 0 で確認）。直近 30 秒の 20ms ごとの音量のうち、声のある部分の上位 5% が
// -20dB になるよう、1 秒ごとに少しずつ合わせる
class AutoGain {
  private static readonly FRAME = 320;
  private static readonly WINDOW_FRAMES = 1500;
  private static readonly UPDATE_FRAMES = 50;
  private static readonly VOICED_DB = -60;
  private readonly levels: number[] = [];
  private sum = 0;
  private n = 0;
  private sinceUpdate = 0;

  constructor(public gainDb: number) {}

  apply(x: Float32Array): Float32Array {
    for (const v of x) {
      this.sum += v * v;
      if (++this.n < AutoGain.FRAME) continue;
      const db = 10 * Math.log10(this.sum / AutoGain.FRAME + 1e-12);
      if (db > AutoGain.VOICED_DB) {
        this.levels.push(db);
        if (this.levels.length > AutoGain.WINDOW_FRAMES) this.levels.shift();
      }
      this.sum = 0;
      this.n = 0;
      if (++this.sinceUpdate >= AutoGain.UPDATE_FRAMES) {
        this.sinceUpdate = 0;
        this.update();
      }
    }
    const g = 10 ** (this.gainDb / 20);
    return x.map((v) => Math.max(-1, Math.min(1, v * g)));
  }

  private update(): void {
    // 声が 1 秒分たまるまでは初期値のまま
    if (this.levels.length < AutoGain.UPDATE_FRAMES) return;
    const sorted = [...this.levels].sort((a, b) => a - b);
    const target = Math.max(0, Math.min(30, -20 - sorted[Math.floor(sorted.length * 0.95)]));
    this.gainDb += (target - this.gainDb) * 0.3;
  }
}

class WavFile {
  private readonly fd: number;
  private bytes = 0;

  constructor(readonly path: string) {
    this.fd = openSync(path, 'w');
    writeSync(this.fd, Buffer.alloc(44)); // ヘッダは close() で書く
  }

  write(pcm: Int16Array): void {
    this.bytes += writeSync(this.fd, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  }

  close(): void {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + this.bytes, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20); // PCM
    h.writeUInt16LE(1, 22); // モノラル
    h.writeUInt32LE(SAMPLE_RATE, 24);
    h.writeUInt32LE(SAMPLE_RATE * 2, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(this.bytes, 40);
    writeSync(this.fd, h, 0, 44, 0);
    closeSync(this.fd);
  }
}

// ---- 録音 → VAD → 音声認識 ----

class Session {
  private readonly sherpa = load.sherpa();
  private readonly model: AsrModel;
  private readonly recognizer;
  private readonly vad;
  private readonly ring = new Ring(SAMPLE_RATE * RING_SECONDS);
  private pending = new Float32Array(0);
  private t0 = 0; // サンプル 0 の実時刻
  private prevEnd = 0; // 直前の区間の終わり（サンプル）。前の余白はここより前に広げない
  private lastLevel = 0;
  private speechSec = 0;
  private decodeMs = 0;
  private readonly wav?: WavFile;
  private readonly gain?: AutoGain;
  private recorder?: Recorder;
  readonly modelKind: string;
  readonly loadMs: number;

  constructor(private readonly options: StartOptions) {
    const started = performance.now();
    this.model = asrModel(options.modelDir, options.numThreads, options.hotwords);
    this.recognizer = createRecognizer(this.sherpa, this.model);
    this.vad = new this.sherpa.Vad(vadConfig(options.vadModel), RING_SECONDS);
    this.modelKind = this.model.kind;
    this.loadMs = Math.round(performance.now() - started);
    if (options.saveWav) this.wav = new WavFile(options.saveWav);
    if (options.autoGain) this.gain = new AutoGain(options.initialGainDb ?? 0);
  }

  start(): string {
    this.recorder = openRecorder(this.options, (pcm) => this.feed(pcm), (e) => void send({ type: 'error', message: errorText(e) }));
    return this.recorder.device;
  }

  private feed(pcm: Int16Array): void {
    if (this.t0 === 0) this.t0 = Date.now() - (pcm.length / SAMPLE_RATE) * 1000;
    // 保存するのは元の音量のまま（後から設定を変えて処理し直せるように）
    this.wav?.write(pcm);

    const raw = new Float32Array(pcm.length);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      raw[i] = pcm[i] / 32768;
      sum += raw[i] * raw[i];
    }
    const x = this.gain ? this.gain.apply(raw) : raw;
    this.ring.push(x);
    const now = Date.now();
    if (now - this.lastLevel >= LEVEL_INTERVAL_MS) {
      this.lastLevel = now;
      void send({ type: 'level', rms: Math.sqrt(sum / Math.max(1, raw.length)), gainDb: +(this.gain?.gainDb ?? 0).toFixed(1) });
    }

    // VAD には決まった長さの窓で渡す
    const merged = new Float32Array(this.pending.length + x.length);
    merged.set(this.pending);
    merged.set(x, this.pending.length);
    let offset = 0;
    for (; offset + VAD_WINDOW <= merged.length; offset += VAD_WINDOW) {
      this.vad.acceptWaveform(merged.subarray(offset, offset + VAD_WINDOW));
      this.drain();
    }
    this.pending = merged.slice(offset);
  }

  private drain(): void {
    while (!this.vad.isEmpty()) {
      const segment: { start: number; samples: Float32Array } = this.vad.front(EXTERNAL_BUFFER);
      this.vad.pop();
      // 前の余白は、直前の区間と重ならない範囲で足す（同じ言葉を二度認識しないため）
      const from = Math.max(this.prevEnd, segment.start - Math.round(this.options.padBefore * SAMPLE_RATE));
      const to = segment.start + segment.samples.length + Math.round(this.options.padAfter * SAMPLE_RATE);
      this.prevEnd = segment.start + segment.samples.length;
      const samples = this.ring.slice(from, to);
      const started = performance.now();
      const text = recognize(this.recognizer, this.model, samples);
      const decodeMs = performance.now() - started;
      this.decodeMs += decodeMs;
      this.speechSec += samples.length / SAMPLE_RATE;
      if (!text) continue;
      const start = this.t0 + (Math.max(from, 0) / SAMPLE_RATE) * 1000;
      void send({ type: 'utterance', start, end: start + (samples.length / SAMPLE_RATE) * 1000, text, decodeMs: Math.round(decodeMs) });
    }
  }

  stop(): FromWorker {
    this.recorder?.stop();
    this.vad.flush();
    this.drain();
    this.wav?.close();
    return {
      type: 'stopped',
      audioSec: +(this.ring.total / SAMPLE_RATE).toFixed(1),
      speechSec: +this.speechSec.toFixed(1),
      decodeSec: +(this.decodeMs / 1000).toFixed(2),
      wav: this.wav?.path,
    };
  }
}

// ---- 親からの指示 ----

function probe(): ProbeResult {
  const result: ProbeResult = {
    type: 'probe',
    versions: { node: process.versions.node, electron: process.versions.electron, napi: process.versions.napi, execPath: process.execPath },
    sherpa: { ok: false },
    recorders: { decibri: { ok: false }, pvrecorder: { ok: false } },
  };
  try {
    load.sherpa();
    result.sherpa.ok = true;
  } catch (e) {
    result.sherpa.error = errorText(e);
  }
  try {
    result.recorders.decibri = { ok: true, devices: load.decibri().inputDevices().map((d: { name: string }) => d.name) };
  } catch (e) {
    result.recorders.decibri.error = errorText(e);
  }
  try {
    result.recorders.pvrecorder = { ok: true, devices: load.pvrecorder().PvRecorder.getAvailableDevices() };
  } catch (e) {
    result.recorders.pvrecorder.error = errorText(e);
  }
  return result;
}

let session: Session | undefined;

process.on('message', async (msg: ToWorker) => {
  try {
    switch (msg.type) {
      case 'probe':
        await send(probe());
        break;
      case 'start': {
        session = new Session(msg.options);
        const device = session.start();
        await send({ type: 'ready', modelKind: session.modelKind, loadMs: session.loadMs, device });
        break;
      }
      case 'stop':
        if (session) await send(session.stop());
        session = undefined;
        process.exit(0);
    }
  } catch (e) {
    await send({ type: 'error', message: errorText(e) });
  }
});

process.on('disconnect', () => process.exit(0));
