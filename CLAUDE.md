# runScript — agent guide

This file is dual-purpose: **setup instructions** when you're working *in* this repo,
and the **canonical copy of the running-scripts protocol** the tool exists to enforce.

---

## If the user asks you to "set this up"

Do these in order. Ask before any machine-global step.

1. **Confirm Bun** is installed: `bun --version`. If missing, tell the user to run
   `curl -fsSL https://bun.sh/install | bash` and stop.
2. **Install the CLI**: run `./install.sh`. It symlinks `runScript.ts` →
   `~/.local/bin/runScript`, makes it executable, and ensures `~/.local/bin` is on PATH
   (zsh/bash). It is idempotent. *(install.sh never edits `~/.claude/CLAUDE.md`.)*
3. **Verify** it resolves: `command -v runScript` and `runScript help`. If PATH was just
   modified, tell the user to open a new terminal or `exec $SHELL`.
4. **Offer (ask first!)** to append `rules/claude-rules.md` to the user's global
   `~/.claude/CLAUDE.md` so the discipline applies across all their projects. Only do
   this with explicit consent. Suggested approach:
   `cat rules/claude-rules.md >> ~/.claude/CLAUDE.md` — but confirm the file's current
   contents first and don't duplicate an existing copy.

---

## The protocol (this is the behavior runScript enforces)

Before running anything, state an expected wall-clock time. Threshold = **1 minute**.

- **≤ 1 min:** run foreground with the Bash `timeout` parameter ~2× your estimate.
  Never park a foreground call at the max "just in case" — that is the idle trap.
- **> 1 min:** you MUST go through `runScript`:
  1. `runScript start <name> --eta <est> --parallel "<how>" -- <command>`
     — it **refuses** without `--eta` and `--parallel`. Declare both every time.
     **A rough first `--eta` is fine** — don't stall measuring throughput up front. The
     first `tick` recomputes the ETA from real progress within ~55s; correct yourself to
     the user then. Guess, then refine.
  2. Loop `runScript tick <name>` until it prints `Finished`. Each call blocks until the
     job exits or the current poll interval, then prints a snapshot **and a footer telling
     you the exact next command** — follow it.
  3. **Every cycle, relay current %, rate, and a recomputed ETA to the user.**
  4. **The poll interval auto-widens** (≈55s for the first few checks, then 2m→4m→8m→16m)
     once the job proves healthy, so long jobs don't burn dozens of turns. A `tick` that
     blocks for minutes is **intentional, not a hang** — it returns the instant the job
     finishes, stalls, or slips past ETA. When it widens, **tell the user** ("healthy, now
     checking every ~4m"). Any anomaly snaps the interval back to tight polling.
  5. `OVER ESTIMATE` → `runScript stop` + reassess. `STALLED` (no progress while running)
     that persists → stop and investigate. `NO PROGRESS SIGNAL` → stop and ask the user to
     run it in their own terminal.
- **Never** write shell `until`/`sleep` poll-loops — the bounded wait lives inside `tick`.
- Make long jobs resumable (checkpoint + idempotent/UPSERT loop). Re-`start` with the same
  name resumes from the checkpoint.
- Prefer **TypeScript** (Bun + Prisma); Python only for Python-only libraries.

The loop, in one line: **`start` once → `tick` repeatedly (relay ETA each time) → stop when
`tick` says `Finished`.** You only ever learn the job finished by calling `tick`, so you
can't idle — and the tool's own output always tells you the next step.

---

## CLI reference

```
runScript start <name> --eta <dur> --parallel "<how>" [--max <dur>] -- <command...>
runScript tick   <name>      # heartbeat: blocks until exit OR the poll interval, then a snapshot
runScript status <name>      # non-blocking snapshot
runScript stop   <name>      # kill the detached job (checkpoint preserved)
runScript list               # runs in this project + status
runScript logs   <name> [--out|--err|--progress]
runScript helper <ts|sh|py> [--out <path>]   # scaffold the progress/checkpoint helper into a project
```

Durations: `90s`, `8m`, `1h` (bare number = seconds). `--max` defaults to 4× `--eta`.

## Progress contract

A wrapped command reports progress by overwriting a single line at `$RUNSCRIPT_PROGRESS`:

```
<done> <total> <message...>
```

runScript injects three env vars into the child: `RUNSCRIPT_PROGRESS` (that file),
`RUNSCRIPT_NAME`, `RUNSCRIPT_RUN_DIR` (where checkpoints/logs live). Don't hand-roll the
format — **scaffold the helper into the project you're working in** and import it locally:

```sh
runScript helper ts --out scripts/runscript.ts   # then: import { progress, mapLimit, checkpoint } from "./scripts/runscript.ts"
```

- **TS** (preferred): `progress()`, `mapLimit()` (bounded concurrency), `checkpoint()`
  (resume). See `examples/demo.ts` for the canonical shape.
- **bash**: `progress <done> <total> <msg>`.
- **python**: `progress(done, total, msg="")`, `checkpoint()` — **only** when an essential
  library is Python-only (see "If you must use Python" below).

Per-project state lives in `./.runs/<name>/` (gitignored automatically).

## Language: TypeScript by default

Write scripts in **TypeScript on Bun** by default — one-offs, data migrations, batch jobs,
glue. Type-safe, clean bounded concurrency (`mapLimit`), pairs with Prisma for DB work.

**If you must use Python** (an essential library exists only in Python — not "I know Python
better"): use `runScript helper py` so the script still emits progress in the engine's
format and checkpoints correctly. The Python helper exists as that escape hatch, not as a
sign Python is an equal default.
