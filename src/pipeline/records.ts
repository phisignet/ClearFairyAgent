// 記録のフォルダ（.clearfairy/sessions/<日時>/）にあるファイルの読み書き。vscode に依存しない。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Action } from '../capture/actions';
import type { SpeechModelId } from '../config';
import type { Sentence, Utterance } from './sentences';
import type { Step, Task } from './steps';

export interface SessionInfo {
  id: string;
  startedAt: number;
  endedAt?: number;
  workspace?: string;
  speechModel: SpeechModelId;
  device?: string;
  // lostSec: 録音していた時間のうち、マイクから届かなかった音声の秒数
  stats?: { audioSec: number; speechSec: number; decodeSec: number; lostSec?: number; utterances: number; actions: number };
}

// steps.json に保存する形（操作は id だけ持つ）
export interface StoredStep extends Omit<Step, 'actionGroups'> {
  actionGroups: { id: string; kind: Action['kind']; element: string; actions: string[] }[];
}

export interface StoredSteps {
  tasks?: Task[];
  steps: StoredStep[];
}

const readJson = <T>(file: string) => JSON.parse(readFileSync(file, 'utf8')) as T;
const writeJson = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2));

export const readSessionInfo = (dir: string) => readJson<SessionInfo>(join(dir, 'session.json'));
export const writeSessionInfo = (dir: string, info: SessionInfo) => writeJson(join(dir, 'session.json'), info);

// まだ作っていなければ undefined
export const readSteps = (dir: string): StoredSteps | undefined => (existsSync(join(dir, 'steps.json')) ? readJson<StoredSteps>(join(dir, 'steps.json')) : undefined);
export const writeSteps = (dir: string, tasks: Task[], steps: StoredStep[]) => writeJson(join(dir, 'steps.json'), { version: 3, generatedAt: Date.now(), tasks, steps });

export const readSentences = (dir: string): Sentence[] => (existsSync(join(dir, 'sentences.json')) ? readJson<Sentence[]>(join(dir, 'sentences.json')) : []);
export const writeSentences = (dir: string, sentences: Sentence[]) => writeJson(join(dir, 'sentences.json'), sentences);

// 発話や操作が 1 件も無いセッションでは、ファイル自体が無い
const readJsonl = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as T)
    : [];

export const readActions = (dir: string) => readJsonl<Action>(join(dir, 'actions.jsonl'));
export const readUtterances = (dir: string) => readJsonl<Utterance>(join(dir, 'utterances.jsonl'));
