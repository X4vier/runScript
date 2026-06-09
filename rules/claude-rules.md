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
  2. Loop `runScript tick <name>`. Each call blocks until the job exits **or ~55s**,
     then prints a snapshot — so you are never idle for more than a minute.
  3. **Every cycle, relay to the user**: current %, rate, and a recomputed ETA.
  4. If the ETA blows past your estimate (the snapshot flags `OVER ESTIMATE`),
     `runScript stop <name>` and reassess.
  5. If `tick` reports `NO PROGRESS SIGNAL`, stop and **ask the user to run it in their
     own terminal** — don't wait blind.
- **Never** write shell `until`/`sleep` poll-loops — they leak orphaned shells. The
  bounded wait lives *inside* `runScript tick`.
- Make long jobs **resumable**: checkpoint after each unit and keep the loop body
  idempotent (UPSERT, not blind insert) so a kill/timeout resumes cleanly. Re-running
  `runScript start <same-name>` resumes from the checkpoint.
- Wrapped commands report progress by writing a single overwritten line
  `<done> <total> <message>` to `$RUNSCRIPT_PROGRESS`. Use the shipped helpers
  (`helpers/runScript.{ts,sh,py}`) — `progress()`, plus `mapLimit()`/`checkpoint()` in TS.
- **If progress is genuinely unmeasurable**, do NOT use `runScript` — ask the human to
  run it in their own terminal instead of estimating blind.

### Language for scripts

Default to **TypeScript on Bun** for any script you write or run — one-offs, data
migrations, batch jobs, glue. It's type-safe, has clean bounded concurrency (`mapLimit`),
and pairs with Prisma for DB work. Reach for **Python only when an essential library is
Python-only** (e.g. a specific ML/scientific package with no JS equivalent) — and only for
the part that genuinely needs it. "I know Python better" is not a reason; "this library
exists only in Python" is.
