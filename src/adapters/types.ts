/** Normalised model shared by every adapter. */

export type SourceId =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'gemini-cli'
  | 'antigravity';

export const SOURCE_IDS: SourceId[] = [
  'claude-code',
  'codex',
  'opencode',
  'gemini-cli',
  'antigravity',
];

export interface ToolCall {
  name: string;
  /** Summary of the tool input, already size-bounded by the adapter. */
  input: string;
  ok: boolean;
  error?: string;
  outputChars: number;
  /** Output text when the adapter could recover it; truncated later by the packer. */
  output?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

/**
 * One real user message plus everything the agent did until the next real user
 * message. `nextUserText` is deliberately part of the unit: the user's reaction
 * is the closest thing to ground truth about whether the turn landed.
 */
export interface Exchange {
  id: string;
  tool: SourceId;
  sessionId: string;
  index: number;
  project: string | null;
  model: string | null;
  startedAt: string;
  endedAt: string;
  userText: string;
  assistantText: string;
  thinkingChars: number;
  toolCalls: ToolCall[];
  usage: Usage | null;
  nextUserText: string | null;
  interrupted: boolean;
  permissionDenials: number;
  isSidechain: boolean;
}

export interface SessionMeta {
  tool: SourceId;
  sessionId: string;
  path: string;
  project: string | null;
  title: string | null;
  startedAt: string | null;
  endedAt: string | null;
  bytes: number;
}

export interface ParsedSession {
  meta: SessionMeta;
  exchanges: Exchange[];
}

export interface Adapter {
  id: SourceId;
  label: string;
  /** Where this adapter looks, shown by `doctor`. */
  roots: () => string[];
  /** Session refs found on disk. Empty when the tool isn't installed. */
  discover: () => Promise<string[]>;
  parse: (ref: string) => Promise<ParsedSession>;
}
