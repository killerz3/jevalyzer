/** Shared text helpers used by adapters and the budget packer. */

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const USER_REQUEST = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/;

/**
 * Harness-injected reminder blocks are not the user talking, and on this
 * machine they are a large share of raw prompt bytes. Strip them before the
 * text is either scored or counted against the token budget.
 */
export function stripReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER, '').trim();
}

/** Antigravity wraps the real prompt in a USER_REQUEST envelope. */
export function unwrapUserRequest(text: string): string {
  const m = USER_REQUEST.exec(text);
  return (m?.[1] ?? text).trim();
}

const CHANNEL = /^<channel\s([^>]*)>([\s\S]*?)<\/channel>\s*$/;

/**
 * Messages bridged in from a chat platform (the Discord daemon, for instance)
 * arrive wrapped in a `<channel ...>` envelope AND flagged `isMeta`, even though
 * they are the most genuinely human input in the whole log. Unwrap them.
 */
export function unwrapChannel(
  text: string,
): { body: string; source: string | null; user: string | null } | null {
  const m = CHANNEL.exec(text.trim());
  if (!m) return null;
  const attrs = m[1] ?? '';
  const attr = (k: string) => new RegExp(`${k}="([^"]*)"`).exec(attrs)?.[1] ?? null;
  return { body: (m[2] ?? '').trim(), source: attr('source'), user: attr('user') };
}

/** Keep the head and the tail: intent lives at the top, claims at the bottom. */
export function headTail(text: string, head: number, tail: number): string {
  if (text.length <= head + tail) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n...[${omitted} chars omitted]...\n${text.slice(-tail)}`;
}

/** Local token estimate; calibrated against real usage at runtime. */
export function estimateTokens(chars: number, divisor = 3.7): number {
  return Math.ceil(chars / divisor);
}

export function stringify(value: unknown, cap = 100_000): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.slice(0, cap);
  try {
    return JSON.stringify(value).slice(0, cap);
  } catch {
    return String(value).slice(0, cap);
  }
}

export function expandHome(p: string): string {
  const home = process.env.HOME ?? '';
  return p.startsWith('~') ? home + p.slice(1) : p;
}

/**
 * Claude Code names project dirs by replacing every non-alphanumeric char in the
 * cwd with a hyphen, which is lossy: `-home-agent-tis-watch` could be
 * `/home/agent/tis-watch` or `/home/agent/tis/watch`. So this is only a display
 * fallback - the authoritative cwd is the `cwd` field on the records themselves.
 */
export function projectLabelFromDir(name: string): string {
  return name.replace(/^-/, '');
}

/** Short display name for a project path. */
export function shortProject(path: string | null): string {
  if (!path) return 'unknown';
  const home = process.env.HOME ?? '';
  const rel = home && path.startsWith(home) ? '~' + path.slice(home.length) : path;
  return rel === '~' ? '~' : rel;
}
