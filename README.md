# runScript

A reusable background-job runner for Claude Code agents (and humans). It exists to kill
one specific failure mode: an agent runs a script that *should* take 2 minutes, it
actually takes 20 (bad parallelism, a hang, a process that never exits), and the agent
sits **idle doing nothing** the whole time.

runScript makes that structurally impossible by **inverting control of the heartbeat**.
Instead of trusting the agent to remember to check on a job, the CLI *is* the heartbeat:
the agent only learns a job finished by calling `tick`, and **every `tick` returns in
≤ ~55 seconds**. So the agent can't idle for more than a minute and can't skip a progress
check — the mechanics enforce the behavior.

```
start once  →  tick repeatedly (relay ETA)  →  stop when tick says Finished
```

The first checks stay tight (~55s) — that's when a job is most likely to turn out broken or
slow. Once a job has proven healthy, the poll interval **auto-widens** (2m → 4m → 8m → 16m
cap) so a 40-minute job doesn't cost 40 agent turns; any anomaly (stall, over-estimate, no
signal, exit) returns immediately and snaps the interval back to tight.

## Install

Requires [Bun](https://bun.sh). Then:

```sh
./install.sh
```

This symlinks the CLI to `~/.local/bin/runScript`, makes it executable, and ensures
`~/.local/bin` is on your PATH. It's idempotent and never touches your `~/.claude/CLAUDE.md`.

To apply the discipline across **all** your projects, merge `rules/claude-rules.md` into your
global `~/.claude/CLAUDE.md` (or just ask Claude Code, in this repo, to "set this up" — it
will offer to do it with your consent).

## Usage

```sh
runScript start <name> --eta <dur> --parallel "<how>" [--max <dur>] -- <command...>
runScript tick   <name>      # heartbeat: blocks until exit OR the poll interval, then a snapshot
runScript status <name>      # non-blocking snapshot
runScript stop   <name>      # kill the detached job (checkpoint preserved)
runScript list               # runs in this project + status
runScript logs   <name> [--out|--err|--progress]
runScript helper <ts|sh|py> [--out <path>]   # scaffold the progress/checkpoint helper into any project
```

`start` **refuses** unless you declare both `--eta` (your wall-clock estimate) and
`--parallel` (how it's parallelized, or why it can't be). That's the point — it forces a
committed estimate every time. If progress is genuinely unmeasurable, *don't* use runScript;
run it in a terminal you watch.

Durations: `90s`, `8m`, `1h` (bare number = seconds). `--max` is a hard self-kill ceiling
(default 4× `--eta`) — handy on macOS, which has no `timeout` binary.

### Example

```sh
# 584 PDFs, 8-way concurrency, expected ~8 minutes
runScript start ingest --eta 8m --parallel "mapLimit 8 over 584 PDFs" -- bun ingest.ts

# then loop this; each call returns within ~55s with a fresh ETA:
runScript tick ingest
#  ▶ running  "ingest"  ·  elapsed 55s / est 8m
#    progress 96/584 (16%)  ·  rate 1.75/s  ETA 4m39s
#    last: ingested 2023-Q3.pdf
```

When `tick` prints `✓ done` (or `✗ failed`/`✗ killed`), you're finished.

## How a wrapped script reports progress

runScript injects `RUNSCRIPT_PROGRESS`, `RUNSCRIPT_NAME`, and `RUNSCRIPT_RUN_DIR` into the
child. The script overwrites a single line at `$RUNSCRIPT_PROGRESS`:

```
<done> <total> <message...>
```

The engine reads it each tick, timestamps it into `samples.jsonl`, and derives rate + ETA —
robust even if the script only emits a crude `done total` line.

**Using the helpers from another project.** They live in this repo, so don't try to import
across repos — scaffold a local copy into the project you're working in:

```sh
runScript helper ts --out scripts/runscript.ts
# then:  import { progress, mapLimit, checkpoint } from "./scripts/runscript.ts";
```

Use the helpers instead of hand-rolling the format:

```ts
// examples/demo.ts
import { progress, checkpoint, mapLimit } from "./helpers/runScript.ts";

const p = progress("ingest");
const ck = checkpoint<{ done: string[] }>("ingest", { done: [] });
const todo = files.filter((f) => !ck.state.done.includes(f));   // skip done on resume
p.setTotal(todo.length);
await mapLimit(todo, 8, async (f) => {
  await ingestOne(f);                  // idempotent (UPSERT)
  ck.state.done.push(f); ck.save();    // checkpoint after each unit
  p.tick(f);
});
p.finish(); ck.clear();
```

- `helpers/runScript.ts` — `progress()`, `mapLimit()`, `checkpoint()` (preferred; Bun + TS)
- `helpers/runScript.sh` — `progress <done> <total> <msg>`
- `helpers/runScript.py` — `progress(done, total, msg="")`, `checkpoint()` (Python-only libs)

### Why a Python helper, in a "TypeScript by default" tool?

It's an **escape hatch, not a peer option**. Default to TypeScript on Bun for everything;
reach for Python *only* when an essential library exists only in Python (a specific
ML/scientific package with no JS equivalent) — and only for the part that needs it. When
that happens, you still want the script to integrate correctly (right progress format, real
checkpoint/resume) rather than hand-roll it. The helper's presence doesn't make Python an
equal default; the rules and `CLAUDE.md` keep TypeScript first.

## Resume

Long jobs are resumable. `checkpoint()` persists JSON in the run dir and loads it on start,
so a re-run skips finished units — provided your loop body is **idempotent** (UPSERT, not
blind insert). Kill a job with `runScript stop`, then `runScript start` with the same name to
pick up where it left off.

## Storage

Per-project, under `./.runs/<name>/`:

| file | what |
|------|------|
| `meta.json` | pid, command, eta, max, parallel desc, start time |
| `out.log` / `err.log` | child stdout / stderr |
| `progress` | latest overwritten `done total message` line |
| `samples.jsonl` | timestamped progress reads (rate/ETA source) |
| `*.checkpoint.json` | resume state |

`.runs/` is appended to the project's `.gitignore` on first use.

## Design notes

- **Adaptive poll interval.** `tick` blocks ~55s for the first few checks (when a job is
  most likely broken/slow), then widens along `55s → 2m → 4m → 8m → 16m` *only while the
  job stays healthy*. It returns early on exit, `--max`, a developing stall, over-estimate,
  or no-signal — and any of those snaps the next interval back to tight. So you get cheap
  watching of long healthy jobs without going blind on a job that turns bad. Waits clamp to
  the expected finish so they never overshoot it.
- **Stall detection** with an adaptive threshold (scaled to the job's own progress cadence)
  catches a job that was advancing and then hangs — even when its ETA looks fine.
- **Detached** children (`detached: true` + `unref()`) run in their own session, so they
  survive between `runScript` invocations and aren't tied to the agent's shell.
- A tiny `sh` wrapper records the real exit code, so `status`/`tick` report `done`/`failed`
  accurately even though the job isn't a child of the CLI process.
- No `timeout` binary dependency (macOS has none) — the `--max` ceiling self-kills in-process.
- Dependency-light, POSIX-portable (macOS + Linux, zsh/bash).

See `CLAUDE.md` for the full agent protocol.
