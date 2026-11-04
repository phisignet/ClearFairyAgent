// 設定（package.json の contributes.configuration と対応）。
import { isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';

// 音声認識モデル。asset は sherpa-onnx のリリースでの名前
export const SPEECH_MODELS = {
  'whisper-turbo': { asset: 'sherpa-onnx-whisper-turbo', sizeMB: 538, label: 'Whisper turbo（正確・重い）' },
  'zipformer-ja-en': { asset: 'sherpa-onnx-zipformer-ja-en-reazonspeech-2025-01-17', sizeMB: 418, label: 'zipformer 日英（軽い・速い）' },
} as const;

export type SpeechModelId = keyof typeof SPEECH_MODELS;

export const VAD_ASSET = 'silero_vad.onnx';

export interface Settings {
  speechModel: SpeechModelId;
  // 空ならこの拡張機能の保存領域（globalStorage）の models/
  modelsDir: string;
  threads: number;
  keepAudio: boolean;
  keepEvents: boolean;
  llmModel: string;
}

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration('clearfairy');
  const model = c.get<string>('speech.model', 'whisper-turbo');
  // 相対パスはワークスペースのフォルダから（開発用の playground でリポジトリの .cache/models を指すため）
  const modelsDir = c.get<string>('speech.modelsDir', '');
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return {
    speechModel: model in SPEECH_MODELS ? (model as SpeechModelId) : 'whisper-turbo',
    modelsDir: modelsDir && !isAbsolute(modelsDir) && folder ? resolve(folder, modelsDir) : modelsDir,
    threads: c.get<number>('speech.threads', 4),
    keepAudio: c.get<boolean>('speech.keepAudio', false),
    keepEvents: c.get<boolean>('capture.keepEvents', false),
    llmModel: c.get<string>('llm.model', 'claude-haiku-5.5'),
  };
}
