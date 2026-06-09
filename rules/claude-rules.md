<!-- runScript protocol — merge this block into your global ~/.claude/CLAUDE.md.
     It makes agents commit to a time estimate before running anything and never
     sit idle while a job runs. Requires the `runScript` CLI on PATH. -->

## Running scripts

Before running anything, state an expected wall-clock time. Threshold = **1 minute**.

- **≤ 1 min:** run in the foreground with the Bash `timeout` parameter set to ~2× your
  estimate. Never park a foreground call at the max "just in case" — that is the idle trap.
- **> 1 min:** you MUST go through `runScript`. Never block a foreground Bash call on a
  long job.
  1. `runScript start <name> --eta <est> --parallel "<how>" -- <command>`
     (it refuses without `--eta` and `--parallel` — declare both every time).
  2. Loop `runScript tick <name>`. Each call blocks until the job exits **or the current
     poll interval**, then prints a snapshot. **Just keep calling `tick` until it says
     `Finished`** — read its footer; it tells you the exact next command.
  3. **Every cycle, relay to the user**: current %, rate, and a recomputed ETA.
  4. **The poll interval auto-widens.** The first checks are ~55s; once the job has been
     healthy for a few checks the interval grows (2m → 4m → 8m → 16m cap) so a long job
     doesn't cost dozens of turns. A `tick` that blocks for minutes is **working as
     intended, not hung** — it still returns the instant the job finishes, stalls, or
     slips past ETA. When the interval widens, **say so to the user** (e.g. "job healthy,
     I'll now check every ~4m").
  5. If the snapshot flags `OVER ESTIMATE` or `STALLED`, the interval snaps back to tight
     polling. If it's `OVER ESTIMATE`, `runScript stop <name>` and reassess. If `STALLED`
     persists, stop and investigate.
  6. If `tick` reports `NO PROGRESS SIGNAL`, stop and **ask the user to run it in their
     own terminal** — don't wait blind.
- **Never** write shell `until`/`sleep` poll-loops — they leak orphaned shells. The
  bounded wait lives *inside* `runScript tick`.
- Make long jobs **resumable**: checkpoint after each unit and keep the loop body
  idempotent (UPSERT, not blind insert) so a kill/timeout resumes cleanly. Re-running
  `runScript start <same-name>` resumes from the checkpoint.
- Wrapped commands report progress by writing a single overwritten line
  `<done> <total> <message>` to `$RUNSCRIPT_PROGRESS`. Don't hand-roll the format — pull
  the blessed helper into the project with `runScript helper ts --out scripts/runscript.ts`
  (or `sh`/`py`), then import `progress()` (+ `mapLimit()`/`checkpoint()` in TS).
- **If progress is genuinely unmeasurable**, do NOT use `runScript` — ask the human to
  run it in their own terminal instead of estimating blind.

### Language for scripts

Default to **TypeScript on Bun** for any script you write or run — one-offs, data
migrations, batch jobs, glue. It's type-safe, has clean bounded concurrency (`mapLimit`),
and pairs with Prisma for DB work. Reach for **Python only when an essential library is
Python-only** (e.g. a specific ML/scientific package with no JS equivalent) — and only for
the part that genuinely needs it. "I know Python better" is not a reason; "this library
exists only in Python" is.
