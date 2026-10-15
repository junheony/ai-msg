import type { Readable, Writable } from 'node:stream';

/** The slice of ChildProcess the engine uses — a real `spawn()` result or the fake child. */
export interface ClaudeChildLike {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', cb: (err: Error) => void): unknown;
}

export type ClaudeSpawnFn = (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => ClaudeChildLike;
