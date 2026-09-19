import { render, Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useMemo, useState } from 'react';
import type { Exchange } from '../adapters/types.ts';
import { preferences } from '../core/prefer.ts';
import { BANK_VERSION } from '../core/questions.ts';
import { groupBy, scoreExchange, type Scored } from '../core/rollup.ts';
import { Store } from '../core/store.ts';
import { shortProject } from '../core/text.ts';

/**
 * Terminal dashboard over the same SQLite store the report reads, so the two
 * surfaces can never disagree. Three panes: the model leaderboard, the exchange
 * list, and a drill-down on one exchange.
 */



function bar(value: number, max: number, width: number): string {
  const n = max > 0 ? Math.round((value / max) * width) : 0;
  return '█'.repeat(Math.max(0, n)) + '·'.repeat(Math.max(0, width - n));
}

function scoreColor(score: number): 'green' | 'yellow' | 'red' {
  return score >= 70 ? 'green' : score >= 50 ? 'yellow' : 'red';
}

type Pane = 'models' | 'list' | 'detail';

function App({ scored, store }: { scored: Scored[]; store: Store }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rowsAvailable = Math.max(6, (stdout?.rows ?? 30) - 16);

  const [pane, setPane] = useState<Pane>('models');
  const [modelIdx, setModelIdx] = useState(0);
  const [listIdx, setListIdx] = useState(0);
  const [filter, setFilter] = useState('');
  const [typing, setTyping] = useState(false);

  const byModel = useMemo(() => groupBy(scored, (s) => s.ev.model), [scored]);
  const prefs = useMemo(() => preferences(scored, byModel), [scored, byModel]);
  const selectedModel = pane === 'models' ? null : byModel[modelIdx]?.key ?? null;

  const list = useMemo(() => {
    const f = filter.toLowerCase();
    return scored
      .filter((s) => (selectedModel ? s.ev.model === selectedModel : true))
      .filter((s) => !f || s.issues.join(' ').toLowerCase().includes(f) || (s.ev.project ?? '').toLowerCase().includes(f))
      .sort((a, b) => a.score - b.score);
  }, [scored, selectedModel, filter]);

  const current = list[listIdx];

  useInput((input, key) => {
    if (typing) {
      if (key.return || key.escape) {
        setTyping(false);
        return;
      }
      if (key.backspace || key.delete) return setFilter((f) => f.slice(0, -1));
      if (input) setFilter((f) => f + input);
      return;
    }
    if (input === 'q' || key.escape) {
      if (pane === 'detail') return setPane('list');
      if (pane === 'list') return setPane('models');
      return exit();
    }
    if (input === '/') {
      setTyping(true);
      setListIdx(0);
      return;
    }
    if (key.return) {
      if (pane === 'models') {
        setPane('list');
        setListIdx(0);
      } else if (pane === 'list') setPane('detail');
      return;
    }
    const move = (delta: number) => {
      if (pane === 'models') setModelIdx((i) => Math.max(0, Math.min(byModel.length - 1, i + delta)));
      else setListIdx((i) => Math.max(0, Math.min(list.length - 1, i + delta)));
    };
    if (key.downArrow || input === 'j') move(1);
    if (key.upArrow || input === 'k') move(-1);
    if (key.pageDown) move(10);
    if (key.pageUp) move(-10);
  });

  const maxScore = Math.max(...byModel.map((g) => g.score), 1);
  const overall = scored.reduce((a, s) => a + s.score, 0) / Math.max(1, scored.length);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold>jevalyzer</Text>
        <Text dimColor>
          {scored.length} exchanges · mean {overall.toFixed(1)} · preferred {prefs[0]?.model ?? '-'}
        </Text>
      </Box>

      {pane === 'models' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{'MODEL'.padEnd(30)}{'SCORE'.padStart(6)}  {'DELIV'.padStart(6)}  {'CORR'.padStart(5)}  N</Text>
          {byModel.map((g, i) => (
            <Text key={g.key} inverse={i === modelIdx}>
              {g.key.slice(0, 29).padEnd(30)}
              <Text color={scoreColor(g.score)}>{g.score.toFixed(1).padStart(6)}</Text>
              {'  '}
              {`${(g.deliveredRate * 100).toFixed(0)}%`.padStart(6)}
              {'  '}
              {`${(g.correctionRate * 100).toFixed(0)}%`.padStart(5)}
              {'  '}
              {String(g.n).padStart(4)}  <Text dimColor>{bar(g.score, maxScore, 18)}</Text>
            </Text>
          ))}
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Preference index (behaviour, not just score)</Text>
            {prefs.map((p) => (
              <Text key={p.model}>
                {'  '}
                {p.model.slice(0, 28).padEnd(29)}
                <Text color={scoreColor(p.rank)}>{p.rank.toFixed(0).padStart(4)}</Text>
                {'  '}
                <Text dimColor>{p.reliable ? '' : 'small sample'}</Text>
              </Text>
            ))}
          </Box>
        </Box>
      ) : pane === 'list' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {selectedModel ?? 'all models'} · {list.length} exchanges{filter ? ` · filter "${filter}"` : ''}
          </Text>
          {list.slice(Math.max(0, listIdx - rowsAvailable + 3), Math.max(0, listIdx - rowsAvailable + 3) + rowsAvailable).map((s, i, arr) => {
            const absolute = Math.max(0, listIdx - rowsAvailable + 3) + i;
            const ex = store.exchange(s.ev.exchangeId) as Exchange | null;
            const q = (ex?.userText ?? '').replace(/\s+/g, ' ').slice(0, 54);
            return (
              <Text key={s.ev.exchangeId} inverse={absolute === listIdx}>
                <Text color={scoreColor(s.score)}>{String(Math.round(s.score)).padStart(3)}</Text>
                {'  '}
                {q.padEnd(55).slice(0, 55)}
                {'  '}
                <Text dimColor>{s.issues.slice(0, 2).join(', ').slice(0, 30)}</Text>
              </Text>
            );
          })}
        </Box>
      ) : current ? (
        <Detail scored={current} store={store} />
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {typing
            ? `filter: ${filter}_   enter to apply`
            : pane === 'models'
              ? '↑↓ model   enter drill in   q quit'
              : pane === 'list'
                ? '↑↓ move   enter open   / filter   q back'
                : 'q back'}
        </Text>
      </Box>
    </Box>
  );
}

function Detail({ scored, store }: { scored: Scored; store: Store }) {
  const ex = store.exchange(scored.ev.exchangeId) as Exchange | null;
  const answers = Object.entries(scored.ev.answers);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={scoreColor(scored.score)} bold>
          {scored.score.toFixed(1)}
        </Text>{' '}
        <Text dimColor>
          {scored.ev.model ?? scored.ev.tool} · {shortProject(scored.ev.project)} ·{' '}
          {scored.ev.startedAt.slice(0, 16).replace('T', ' ')}
        </Text>
      </Text>
      {scored.issues.length > 0 && <Text color="red">{scored.issues.join(' · ')}</Text>}
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>PROMPT</Text>
        <Text>{(ex?.userText ?? '').replace(/\s+/g, ' ').slice(0, 400)}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>REPLY</Text>
        <Text>{(ex?.assistantText ?? '(none)').replace(/\s+/g, ' ').slice(0, 400)}</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text dimColor>ANSWERS</Text>
        {answers.map(([k, a]) => (
          <Text key={k}>
            {'  '}
            {k.padEnd(30)}
            {a.type === 'boolean'
              ? (a.probability ?? 0).toFixed(2)
              : a.type === 'score'
                ? (a.score ?? 0).toFixed(2)
                : (a.choice ?? '-')}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

export async function tui(): Promise<void> {
  const store = new Store();
  const evaluations = store.all(BANK_VERSION);
  if (evaluations.length === 0) {
    console.log('Nothing scored yet. Run: jevalyzer analyze');
    store.close();
    return;
  }
  const scored = evaluations.map(scoreExchange);
  const app = render(<App scored={scored} store={store} />);
  await app.waitUntilExit();
  store.close();
}
