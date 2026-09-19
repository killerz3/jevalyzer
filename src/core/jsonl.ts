/**
 * Streaming line reader. Codex session files are documented to reach 700MB-2GB,
 * so nothing here may assume a file fits in memory.
 */
export async function* readLines(path: string): AsyncGenerator<string> {
  const stream = Bun.file(path).stream();
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.length > 0) yield line;
      nl = buf.indexOf('\n');
    }
  }
  buf += decoder.decode();
  if (buf.trim().length > 0) yield buf;
}

export async function* readJsonl<T = unknown>(path: string): AsyncGenerator<T> {
  for await (const line of readLines(path)) {
    try {
      yield JSON.parse(line) as T;
    } catch {
      // A partially written trailing line on a live session. Skip it.
    }
  }
}
