/**
 * Optional redaction (`--redact`). Off by default: full transcript text gives
 * the best scoring fidelity, and the tool says plainly what it sends.
 */

const RULES: [RegExp, string][] = [
  [/\b(sk|vck|ghp|gho|ghu|ghs|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g, '[REDACTED_KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, '[REDACTED_EMAIL]'],
  // Keep the key name, drop the value: "password: hunter2" -> "password: [REDACTED]"
  [/\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi, '$1$2[REDACTED]'],
];

export function redactText(text: string): string {
  let out = text;
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  const home = process.env.HOME;
  if (home) out = out.split(home).join('~');
  return out;
}

/** Walk a JSON-ish value, redacting every string in it. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
