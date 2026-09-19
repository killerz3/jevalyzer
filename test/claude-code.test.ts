import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCode } from '../src/adapters/claude-code.ts';

/**
 * A fixture built from the record shapes that actually broke the parser while
 * it was being written, so each trap has a regression test:
 *  - tool results arrive as `type:"user"` records and are not user turns
 *  - a headless run's opening prompt has no promptId
 *  - a chat-bridged message is flagged isMeta but IS the user speaking
 *  - a local-command caveat is flagged isMeta and is NOT
 *  - tool output lives in `toolUseResult`, not in message.content
 */
const LINES = [
  { type: 'mode', sessionId: 'sess-1' },
  {
    type: 'user',
    sessionId: 'sess-1',
    cwd: '/home/u/proj',
    timestamp: '2026-09-01T10:00:00Z',
    message: { role: 'user', content: 'run the tests\n<system-reminder>ignore me</system-reminder>' },
  },
  {
    type: 'assistant',
    sessionId: 'sess-1',
    timestamp: '2026-09-01T10:00:01Z',
    message: {
      role: 'assistant',
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      content: [
        { type: 'thinking', thinking: '', signature: 'opaque' },
        { type: 'text', text: 'Running them now.' },
        { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'bun test' } },
      ],
    },
  },
  {
    type: 'user',
    sessionId: 'sess-1',
    timestamp: '2026-09-01T10:00:02Z',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false }] },
    toolUseResult: { stdout: '8 pass 0 fail', stderr: '', interrupted: false },
  },
  {
    type: 'user',
    sessionId: 'sess-1',
    isMeta: true,
    timestamp: '2026-09-01T10:01:00Z',
    message: { role: 'user', content: '<local-command-caveat>Caveat: not the user</local-command-caveat>' },
  },
  {
    type: 'user',
    sessionId: 'sess-1',
    isMeta: true,
    timestamp: '2026-09-01T10:02:00Z',
    message: {
      role: 'user',
      content: '<channel source="plugin:discord:discord" user="someone" ts="2026-09-01T10:02:00Z">\nship it\n</channel>',
    },
  },
  {
    type: 'assistant',
    sessionId: 'sess-1',
    timestamp: '2026-09-01T10:02:01Z',
    message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'Shipped.' }] },
  },
];

let dir: string;
let file: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'jevalyzer-'));
  mkdirSync(join(dir, 'projects', '-home-u-proj'), { recursive: true });
  file = join(dir, 'projects', '-home-u-proj', 'sess-1.jsonl');
  Bun.write(file, LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('claude code adapter', () => {
  test('finds exactly the two real user turns', async () => {
    const { exchanges } = await claudeCode.parse(file);
    expect(exchanges).toHaveLength(2);
    expect(exchanges[0]!.userText).toBe('run the tests');
    expect(exchanges[1]!.userText).toBe('ship it');
  });

  test('strips system reminders from the prompt', async () => {
    const { exchanges } = await claudeCode.parse(file);
    expect(exchanges[0]!.userText).not.toContain('ignore me');
  });

  test('recovers tool output from toolUseResult', async () => {
    const { exchanges } = await claudeCode.parse(file);
    const call = exchanges[0]!.toolCalls[0]!;
    expect(call.name).toBe('Bash');
    expect(call.ok).toBe(true);
    expect(call.output).toContain('8 pass 0 fail');
    expect(call.outputChars).toBeGreaterThan(0);
  });

  test('carries model, cwd and full usage including cache', async () => {
    const { exchanges } = await claudeCode.parse(file);
    const e = exchanges[0]!;
    expect(e.model).toBe('claude-opus-5');
    expect(e.project).toBe('/home/u/proj');
    expect(e.usage).toEqual({ input: 10, output: 5, cacheRead: 100, cacheCreate: 20 });
  });

  test('links each exchange to the reaction that follows it', async () => {
    const { exchanges } = await claudeCode.parse(file);
    expect(exchanges[0]!.nextUserText).toBe('ship it');
    expect(exchanges[1]!.nextUserText).toBeNull();
  });

  test('ids are stable across reparses', async () => {
    const a = await claudeCode.parse(file);
    const b = await claudeCode.parse(file);
    expect(a.exchanges.map((e) => e.id)).toEqual(b.exchanges.map((e) => e.id));
  });
});
