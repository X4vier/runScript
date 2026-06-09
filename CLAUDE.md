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
  2. Loop `runScript tick <name>` — each call returns in **≤55s** (on exit, or the cap).
  3. **Every cycle, relay current %, rate, and a recomputed ETA to the user.**
  4. ETA past your estimate (snapshot says `OVER ESTIMATE`) → `runScript stop` + reassess.
  5. `NO PROGRESS SIGNAL` → stop and ask the user to run it in their own terminal.
- **Never** write shell `until`/`sleep` poll-loops — the bounded wait lives inside `tick`.
- Make long jobs resumable (checkpoint + idempotent/UPSERT loop). Re-`start` with the same
  name resumes from the checkpoint.
- Prefer **TypeScript** (Bun + Prisma); Python only for Python-only libraries.

The loop, in one line: **`start` once → `tick` repeatedly (relay ETA each time) → stop when
`tick` says done.** You only ever learn the job finished by calling `tick`, so you can't idle.

---

## CLI reference

```
runScript start <name> --eta <dur> --parallel "<how>" [--max <dur>] -- <command...>
runScript tick   <name>      # heartbeat: blocks until exit OR ~55s, then a snapshot
runScript status <name>      # non-blocking snapshot
runScript stop   <name>      # kill the detached job (checkpoint preserved)
runScript list               # runs in this project + status
runScript logs   <name> [--out|--err|--progress]
```

Durations: `90s`, `8m`, `1h` (bare number = seconds). `--max` defaults to 4× `--eta`.

## Progress contract

A wrapped command reports progress by overwriting a single line at `$RUNSCRIPT_PROGRESS`:

```
<done> <total> <message...>
```

runScript injects three env vars into the child: `RUNSCRIPT_PROGRESS` (that file),
`RUNSCRIPT_NAME`, `RUNSCRIPT_RUN_DIR` (where checkpoints/logs live). Don't hand-roll the
format — use the helpers:

- **TS** (`helpers/runScript.ts`): `progress()`, `mapLimit()` (bounded concurrency),
  `checkpoint()` (resume). See `examples/demo.ts`.
- **bash** (`helpers/runScript.sh`): `progress <done> <total> <msg>`.
- **python** (`helpers/runScript.py`): `progress(done, total, msg="")`, `checkpoint()`.

Per-project state lives in `./.runs/<name>/` (gitignored automatically).
