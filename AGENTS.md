# AGENTS.md — install and run jevalyzer

This file is written for an AI agent (Claude Code, Codex, Gemini CLI, opencode,
Antigravity — anything with a shell) that has been told:

> Follow the AGENTS.md in https://github.com/killerz3/jevalyzer and install and set it up

Work through the phases in order. Each step is **AUTO** (do it, no need to ask)
or **ASK** (you cannot know the answer; stop, ask the user, then continue).
Verify each step before moving on.

Three rules that override anything else you infer:

1. **Never invent, guess or reuse a credential.** Jevalyzer ships with none. The
   key is the user's own; if it is missing, ask.
2. **Nothing leaves the machine until the user has seen the cost.** `scan` and
   `--dry-run` are local. Do not run `analyze` without showing the estimate and
   getting a yes.
3. **Never print the key back** once you have it, and never write it into a
   shell history-visible place other than the config file jevalyzer writes.

What you are installing: a CLI that reads the agent transcripts already on this
disk, scores every exchange with `typesafe-ai/jev` through the Vercel AI
Gateway, and writes an HTML report. Scoring a whole archive costs one to thirty
cents.

---

## Phase 0 — Preconditions (AUTO, ASK only on failure)

| Requirement | How to check | If missing |
|---|---|---|
| OS | `uname -s` → `Linux` or `Darwin` | Windows: ASK the user to run this inside WSL2. Paths below assume a POSIX home. |
| Bun ≥ 1.2 | `bun --version`, else `~/.bun/bin/bun --version` | AUTO: `curl -fsSL https://bun.sh/install \| bash`. Re-check; if it is only at `~/.bun/bin/bun`, use that absolute path everywhere below — do not assume the user's PATH. |
| `git` | `git --version` | AUTO: install with the system package manager. The checkout is the only distribution for now. |
| Sessions to grade | see Phase 1 | If none are found, stop and tell the user; there is nothing to install for. |
| Network | outbound HTTPS to `ai-gateway.vercel.sh` | Corporate proxy: `HTTPS_PROXY` is respected by Bun's fetch. |

Record the Bun path. You need it in every later phase.

---

## Phase 1 — Prove there is something to grade (AUTO, sends nothing)

Run this before anything else. It reads local files only, needs no account, and
is the cheapest way to find out whether this machine is worth scoring:

```bash
git clone https://github.com/killerz3/jevalyzer ~/jevalyzer
cd ~/jevalyzer && bun install
bun start scan
```

If `~/jevalyzer` exists and is not this repo, ASK where to put the checkout and
use that path everywhere below.

Expected: a table of sources with session and exchange counts, then an estimated
cost. Jevalyzer looks in:

| Tool | Path |
|---|---|
| Claude Code | `~/.claude/projects/<project>/<session>.jsonl` |
| Codex CLI | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` |
| opencode | `~/.local/share/opencode/opencode.db` |
| Gemini CLI | `~/.gemini/tmp/<hash>/chats/*.json` |
| Antigravity | `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` |

If the table is empty: the user has no local agent history, or it lives
somewhere non-default. Ask before hunting around their filesystem. Do **not**
proceed to Phase 3.

Report the numbers to the user — exchanges, megabytes, estimated dollars — and
keep them; Phase 5 refers back to the estimate.

---

## Phase 2 — Install (AUTO)

The clone from Phase 1 *is* the install. **Jevalyzer is not on npm yet**, so
there is no `bunx jevalyzer` and no `npm install -g jevalyzer` — if you find
yourself typing either, you are inventing a package that does not exist. Run it
from the checkout:

```bash
cd ~/jevalyzer
bun start            # the whole guided flow
bun start scan       # or any subcommand
```

Only if the user wants to call it from other directories, link it once:

```bash
cd ~/jevalyzer && bun link      # `jevalyzer` now works anywhere; `bun unlink` undoes it
```

Verify: `bun start --version` (or `jevalyzer --version` if you linked) prints a
version. Optionally `bun test` — 26 tests, a few hundred milliseconds — to prove
the checkout is sound.

**For the rest of this file, `jevalyzer …` means `bun start …` run from the
checkout** — or the linked `jevalyzer …` from anywhere, if you did that. Both
take identical arguments.

---

## Phase 3 — The key (ASK; the user does this in a browser)

Jevalyzer uses the user's own account. Three backends; prefer the first.

**Vercel AI Gateway** (default, model `typesafe-ai/jev`)

Send the user this, verbatim, then wait:

1. Open https://vercel.com/d?to=/[team]/~/ai-gateway/api-keys
2. Create a key. It starts `vck_`. Paste it back to me.
3. A card must be on file even for free usage — the Gateway refuses to serve
   requests on a hobby account without one. Free-tier requests are also
   rate-limited; that is handled, runs just go slower.

Then store it — let jevalyzer write the file, do not write it yourself:

```bash
AI_GATEWAY_API_KEY=vck_... jevalyzer auth
```

or, non-interactively, `export AI_GATEWAY_API_KEY=vck_...` for the session.
It lands in `~/.jevalyzer/config.json`, mode 600. Confirm with:

```bash
jevalyzer auth --show      # prints the source and a masked key, never the key
```

**Alternatives**, only if the user refuses to add a card or already has an
account elsewhere:

- `jevalyzer auth --cloudflare` — Workers AI (`CLOUDFLARE_ACCOUNT_ID`,
  `CLOUDFLARE_API_TOKEN`). Jev is a *partner* model there: it is outside the
  free Neurons allocation and returns `2021 Insufficient balance` without
  credit or a BYOK key. Context is 32k rather than 64k; jevalyzer adapts.
- `jevalyzer auth --typesafe` — a direct TypeSafe key (`sk-...`) from
  https://console.typesafe.ai/keys. Waitlisted, no free credit.

Never put a key in a unit file, a dotfile you author, or a command you echo
back. If the user pastes a key in chat, tell them to rotate it afterwards if
the transcript is shared.

---

## Phase 4 — Check the setup end to end (AUTO)

```bash
jevalyzer doctor --probe
```

`--probe` sends one tiny request, costing a fraction of a cent, to prove the
key and the model resolve. Expected: the key source, the SDK version, the
sources found, and `model resolved`.

| Symptom | Cause | Fix |
|---|---|---|
| `No AI Gateway key found` | key not stored | redo Phase 3 |
| `402` / payment required | no card on the Vercel account | Phase 3, or switch backend |
| `model not found` | wrong backend for the model id | drop `--model`; the default follows `--backend` |
| `2021 Insufficient balance` | Cloudflare partner-model billing | add credit or BYOK, or use the Gateway |
| zero sources found | Phase 1 was skipped or paths are non-default | go back to Phase 1 |

---

## Phase 5 — Show the cost, then score (ASK once, then AUTO)

Show exactly what would be sent before sending it:

```bash
jevalyzer analyze --dry-run
```

This prints the request payload byte for byte and sends nothing. Then put the
number from Phase 1 in front of the user and ask one question:

> Scoring N exchanges costs about $X and sends transcript text — prompts,
> replies, tool calls and tool output — to the Vercel AI Gateway. Shall I?
> I can add `--redact` to strip keys, tokens, emails and your home path first.

On yes:

```bash
jevalyzer analyze --yes                 # add --redact if they asked for it
```

Defaults worth knowing before you change them:

| Flag | Default | When to change it |
|---|---|---|
| `--profile` | `minimal` (7 questions) | `extensive` (21) adds the failure heatmap, communication and risk analysis for ~3× the tokens. Ask; do not pick it silently. |
| `--budget` | `$5` | It refuses to exceed this without confirmation. Lower it if the user is nervous. |
| `--patient` | off | One request at a time. Use it on a free key that is being throttled. |
| `--concurrency` | 4 | Leave it. |
| `--redact` | off | On if anything sensitive is in those transcripts. |
| `--force` | off | Only after a question-bank change; it re-pays for cached rows. |

**Ctrl-C is safe.** Every exchange is written to `~/.jevalyzer/jevalyzer.db` the
moment it is scored, and re-running resumes by content hash. If the run ends
early because the free tier throttled, say so plainly and re-run it later — do
not describe a partial run as a complete one.

For a big archive on a free key, this is the documented way to drip it through:

```bash
while ! jevalyzer analyze --patient --yes | grep -q "Nothing new"; do sleep 600; done
```

Only start that loop if the user agreed to a long-running background job.

---

## Phase 6 — The report (AUTO)

```bash
jevalyzer report --out ~/jevalyzer-report.html --open
```

One self-contained HTML file: headline tiles, the preference index, score per
model, quality over time, the failure heatmap, outcome mix, and breakdowns by
CLI, project and session. `--open` needs a desktop session; on a headless box
drop it and give the user the path.

`jevalyzer tui` is the same data in the terminal, which is what you want over
SSH.

Warn the user once, before they share it: **the report contains their project
paths and the opening line of their prompts** (the "By project" and "Sessions
that went worst" sections). It is fine to keep, fine to send to a colleague,
not fine to post publicly without a look.

---

## Phase 7 — Hand-off (AUTO)

Tell the user, without printing the key:

1. Where the checkout is and how to run it again — `bun start` in that directory, with no arguments, does the whole thing. Say whether you linked it.
2. What was scored: exchanges, models, CLIs, what it actually cost.
3. Where things live: report path, `~/.jevalyzer/jevalyzer.db` (cache), `~/.jevalyzer/config.json` (key, mode 600).
4. That re-running only pays for new exchanges, so it is cheap to run weekly.
5. The one caveat in the numbers: the preference index is *relative* to the models compared, and models with very few exchanges are shrunk toward the middle rather than allowed to top the chart.
6. How to remove it: `bun unlink` in the checkout if you linked it, then delete the checkout and `rm -rf ~/.jevalyzer`.

---

## Reference

| Path | Contents |
|---|---|
| `~/.jevalyzer/config.json` | API keys, mode 600 |
| `~/.jevalyzer/jevalyzer.db` | scored exchanges, keyed by content hash |
| `jevalyzer-report.html` | the report, written where you ran it |

Environment variables: `AI_GATEWAY_API_KEY`, `TYPESAFE_AI_API_KEY`,
`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `JEVALYZER_HOME`, `CODEX_HOME`.

Commands: `run` (default), `scan`, `auth`, `analyze`, `report`, `tui`, `doctor`.
Every one takes `--help`.

If something in this file does not match what the CLI does, trust the CLI and
tell the user which step was wrong.
