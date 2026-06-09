#!/usr/bin/env bun
// runScript — a reusable background-job runner for Claude Code agents.
//
// The CLI *is* the heartbeat: `tick` blocks until the job exits OR ~55s, so the
// agent can never idle > 1 minute and can never skip a progress check. See
// CLAUDE.md / rules/claude-rules.md for the agent protocol this enforces.

import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  existsSync,
  openSync,
  closeSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, dirname } from "node:path";

const TICK_MAX_MS = 55_000; // every blocking call returns within this window
const SAMPLE_EVERY_MS = 2_000; // how often tick reads progress during its wait

// ─────────────────────────────────────────────────────────────────────────────
// Durations
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "90s" | "8m" | "1h" | "90" (bare = seconds) → seconds. */
function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|sec|min|hr|hour)?$/i.exec(s.trim());
  if (!m) throw new Error(`bad duration: "${s}" (use 90s, 8m, 1h)`);
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "s").toLowerCase();
  if (unit.startsWith("h")) return n * 3600;
  if (unit.startsWith("m")) return n * 60;
  return n;
}

/** seconds → compact human string (e.g. 95 → "1m35s"). */
function fmtDuration(secs: number): string {
  secs = Math.max(0, Math.round(secs));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${mm}m` : `${h}h`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Project + run storage layout
// ─────────────────────────────────────────────────────────────────────────────

/** Nearest ancestor containing .git (or package.json), else cwd. */
function findProjectRoot(): string {
  let dir = process.cwd();
  while (true) {
    if (existsSync(join(dir, ".git")) || existsSync(join(dir, "package.json"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const PROJECT_ROOT = findProjectRoot();
const RUNS_DIR = join(PROJECT_ROOT, ".runs");
const runDir = (name: string) => join(RUNS_DIR, name);

interface Meta {
  name: string;
  pid: number;
  command: string[];
  eta: number; // seconds
  max: number; // seconds (hard ceiling)
  parallel: string;
  startedAt: number; // epoch ms
}

const metaPath = (n: string) => join(runDir(n), "meta.json");
const outPath = (n: string) => join(runDir(n), "out.log");
const errPath = (n: string) => join(runDir(n), "err.log");
const progressPath = (n: string) => join(runDir(n), "progress");
const samplesPath = (n: string) => join(runDir(n), "samples.jsonl");
const exitCodePath = (n: string) => join(runDir(n), "exit_code");
const killedPath = (n: string) => join(runDir(n), "killed");

function readMeta(name: string): Meta | null {
  const p = metaPath(name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Meta;
  } catch {
    return null;
  }
}

/** Append `.runs/` to the project's .gitignore once. */
function ensureGitignore(): void {
  const gi = join(PROJECT_ROOT, ".gitignore");
  const line = ".runs/";
  let body = "";
  if (existsSync(gi)) {
    body = readFileSync(gi, "utf8");
    if (body.split(/\r?\n/).some((l) => l.trim() === line || l.trim() === ".runs")) {
      return;
    }
    if (body.length && !body.endsWith("\n")) body += "\n";
  }
  writeFileSync(gi, `${body}${line}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Process / progress helpers
// ─────────────────────────────────────────────────────────────────────────────

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    // EPERM means the process exists but we can't signal it → still alive.
    return e?.code === "EPERM";
  }
}

interface Progress {
  done: number;
  total: number;
  message: string;
  raw: string;
}

/** Read the single progress line: "<done> <total> <message...>". */
function readProgress(name: string): Progress | null {
  const p = progressPath(name);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8").trim();
  if (!raw) return null;
  const parts = raw.split(/\s+/);
  const done = Number(parts[0]);
  const total = Number(parts[1]);
  if (!Number.isFinite(done) || !Number.isFinite(total)) {
    return { done: NaN, total: NaN, message: raw, raw };
  }
  return { done, total, message: parts.slice(2).join(" "), raw };
}

interface Sample {
  t: number; // epoch ms
  done: number;
  total: number;
}

function appendSample(name: string, s: Sample): void {
  appendFileSync(samplesPath(name), JSON.stringify(s) + "\n");
}

function readSamples(name: string): Sample[] {
  const p = samplesPath(name);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as Sample;
      } catch {
        return null;
      }
    })
    .filter((s): s is Sample => s != null);
}

/**
 * Record a sample iff (done,total) changed from the last one. Keeps samples.jsonl
 * meaningful for rate even when the child only emits a crude "done total" line.
 */
function maybeSample(name: string, now: number): Sample[] {
  const prog = readProgress(name);
  const samples = readSamples(name);
  if (prog && Number.isFinite(prog.done) && Number.isFinite(prog.total)) {
    const last = samples[samples.length - 1];
    if (!last || last.done !== prog.done || last.total !== prog.total) {
      const s = { t: now, done: prog.done, total: prog.total };
      appendSample(name, s);
      samples.push(s);
    }
  }
  return samples;
}

interface RateEta {
  rate: number | null; // units per second
  etaSecs: number | null; // seconds remaining
  done: number;
  total: number;
}

/** Derive rate from a recent window of samples; ETA = remaining / rate. */
function computeRateEta(samples: Sample[]): RateEta {
  const last = samples[samples.length - 1];
  if (!last) return { rate: null, etaSecs: null, done: 0, total: 0 };
  const { done, total } = last;

  // Window: prefer samples within the last 60s, but always keep ≥2 if available.
  const cutoff = last.t - 60_000;
  let window = samples.filter((s) => s.t >= cutoff);
  if (window.length < 2) window = samples.slice(-2);

  const first = window[0]!;
  const dt = (last.t - first.t) / 1000;
  const dDone = last.done - first.done;
  if (dt <= 0 || dDone <= 0) {
    return { rate: null, etaSecs: null, done, total };
  }
  const rate = dDone / dt;
  const remaining = Math.max(0, total - done);
  return { rate, etaSecs: rate > 0 ? remaining / rate : null, done, total };
}

type State = "running" | "done" | "failed" | "killed";

function jobState(name: string, meta: Meta): { state: State; exitCode: number | null } {
  if (existsSync(killedPath(name))) return { state: "killed", exitCode: null };
  if (existsSync(exitCodePath(name))) {
    const code = Number(readFileSync(exitCodePath(name), "utf8").trim());
    return { state: code === 0 ? "done" : "failed", exitCode: Number.isFinite(code) ? code : null };
  }
  if (isAlive(meta.pid)) return { state: "running", exitCode: null };
  // pid gone and no exit_code written → died hard (SIGKILL/crash).
  return { state: "killed", exitCode: null };
}

function tailLines(file: string, n: number): string[] {
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines.slice(-n);
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot rendering
// ─────────────────────────────────────────────────────────────────────────────

interface Snapshot {
  name: string;
  state: State;
  exitCode: number | null;
  elapsedSecs: number;
  done: number;
  total: number;
  pct: number | null;
  rate: number | null;
  etaSecs: number | null;
  progressMsg: string | null;
  noProgressSignal: boolean;
  overEta: boolean;
  errTail: string[];
}

function snapshot(name: string, meta: Meta, now: number): Snapshot {
  const { state, exitCode } = jobState(name, meta);
  const elapsedSecs = (now - meta.startedAt) / 1000;
  const samples = readSamples(name);
  const re = computeRateEta(samples);
  const prog = readProgress(name);
  const hasSignal = samples.length > 0 || (prog != null && prog.raw.length > 0);
  const pct =
    re.total > 0 && Number.isFinite(re.done) ? Math.round((re.done / re.total) * 100) : null;

  return {
    name,
    state,
    exitCode,
    elapsedSecs,
    done: re.done,
    total: re.total,
    pct,
    rate: re.rate,
    etaSecs: re.etaSecs,
    progressMsg: prog?.message || null,
    noProgressSignal: !hasSignal && state === "running",
    overEta: state === "running" && re.etaSecs != null && elapsedSecs + re.etaSecs > meta.eta * 1.5,
    errTail: tailLines(errPath(name), 4),
  };
}

const STATE_GLYPH: Record<State, string> = {
  running: "▶ running",
  done: "✓ done",
  failed: "✗ failed",
  killed: "✗ killed",
};

function renderSnapshot(s: Snapshot, meta: Meta): string {
  const L: string[] = [];
  L.push(
    `${STATE_GLYPH[s.state]}  "${s.name}"  ·  elapsed ${fmtDuration(s.elapsedSecs)} / est ${fmtDuration(
      meta.eta,
    )}`,
  );

  if (s.total > 0 || s.done > 0) {
    const pctStr = s.pct != null ? `${s.pct}%` : "?%";
    const rateStr = s.rate != null ? `${s.rate.toFixed(2)}/s` : "?/s";
    const etaStr =
      s.state === "running"
        ? s.etaSecs != null
          ? `ETA ${fmtDuration(s.etaSecs)}`
          : "ETA ~?"
        : "";
    L.push(`  progress ${s.done}/${s.total} (${pctStr})  ·  rate ${rateStr}  ${etaStr}`.trimEnd());
  }
  if (s.progressMsg) L.push(`  last: ${s.progressMsg}`);

  if (s.noProgressSignal) {
    L.push("");
    L.push("  ⚠ NO PROGRESS SIGNAL — the job has emitted nothing to $RUNSCRIPT_PROGRESS.");
    L.push("    Either it isn't using the progress helper, or progress is unmeasurable.");
    L.push("    → stop it and ask the human to run it in their own terminal.");
  }
  if (s.overEta) {
    L.push("");
    L.push(
      `  ⚠ OVER ESTIMATE — projected finish is well past your ${fmtDuration(
        meta.eta,
      )} estimate. Consider \`runScript stop ${s.name}\` and reassess.`,
    );
  }
  if ((s.state === "failed" || s.state === "killed") && s.errTail.length) {
    L.push("");
    L.push("  last stderr:");
    for (const line of s.errTail) L.push(`    ${line}`);
  }
  if (s.state === "failed" && s.exitCode != null) L.push(`  exit code: ${s.exitCode}`);
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

interface StartArgs {
  name: string;
  eta?: string;
  parallel?: string;
  max?: string;
  command: string[];
}

function parseStart(argv: string[]): StartArgs {
  const out: StartArgs = { name: "", command: [] };
  let i = 0;
  // first positional = name
  if (argv[0] && !argv[0].startsWith("-")) out.name = argv[i++]!;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      out.command = argv.slice(i + 1);
      break;
    } else if (a === "--eta") out.eta = argv[++i];
    else if (a === "--parallel") out.parallel = argv[++i];
    else if (a === "--max") out.max = argv[++i];
    else if (a.startsWith("--eta=")) out.eta = a.slice(6);
    else if (a.startsWith("--parallel=")) out.parallel = a.slice(11);
    else if (a.startsWith("--max=")) out.max = a.slice(6);
    else if (!out.name && !a.startsWith("-")) out.name = a;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

const GATE_MESSAGE = `BLOCKED — before running, declare:
  --eta <duration>      your wall-clock estimate (e.g. 90s, 8m, 1h)
  --parallel "<how>"    how this is parallelized, or why it can't be
If you can't estimate because progress is unmeasurable, do NOT use runScript —
ask the human to run it in their own terminal.`;

function cmdStart(argv: string[]): number {
  const a = parseStart(argv);

  if (!a.name) {
    console.error("usage: runScript start <name> --eta <dur> --parallel \"<how>\" [--max <dur>] -- <command...>");
    return 2;
  }
  // Pre-run gate — the whole point of the tool.
  if (!a.eta || !a.parallel) {
    console.error(GATE_MESSAGE);
    return 1;
  }
  if (a.command.length === 0) {
    console.error('No command. Put it after `--`, e.g. ... -- bun ingest.ts');
    return 2;
  }

  let etaSecs: number, maxSecs: number;
  try {
    etaSecs = parseDuration(a.eta);
    maxSecs = a.max ? parseDuration(a.max) : etaSecs * 4;
  } catch (e: any) {
    console.error(e.message);
    return 2;
  }

  const dir = runDir(a.name);
  mkdirSync(dir, { recursive: true });
  ensureGitignore();

  // Fresh run-state, but PRESERVE *.checkpoint.json so re-start resumes.
  // These must be DELETED, not truncated: jobState() keys off existsSync, so a
  // lingering empty `killed`/`exit_code` would mis-report a live run as dead.
  for (const p of [exitCodePath(a.name), killedPath(a.name), samplesPath(a.name), progressPath(a.name)]) {
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {}
    }
  }
  // truncate logs
  writeFileSync(outPath(a.name), "");
  writeFileSync(errPath(a.name), "");

  const env = {
    ...process.env,
    RUNSCRIPT_PROGRESS: progressPath(a.name),
    RUNSCRIPT_NAME: a.name,
    RUNSCRIPT_RUN_DIR: dir,
  };

  const outFd = openSync(outPath(a.name), "a");
  const errFd = openSync(errPath(a.name), "a");

  // Detach: `detached:true` puts the child in its own session/process-group
  // (portable setsid), `unref()` lets THIS process exit while it keeps running.
  // The sh wrapper captures the real exit code so `tick`/`status` can read it
  // even though the job is not our child to waitpid().
  const wrapper = '"$@"; ec=$?; printf "%s" "$ec" > "$RUNSCRIPT_RUN_DIR/exit_code"; exit "$ec"';
  const child = spawn("/bin/sh", ["-c", wrapper, "runScript", ...a.command], {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env,
  });
  child.unref();
  closeSync(outFd);
  closeSync(errFd);

  if (!child.pid) {
    console.error("failed to spawn child");
    return 1;
  }

  const meta: Meta = {
    name: a.name,
    pid: child.pid,
    command: a.command,
    eta: etaSecs,
    max: maxSecs,
    parallel: a.parallel,
    startedAt: Date.now(),
  };
  writeFileSync(metaPath(a.name), JSON.stringify(meta, null, 2));

  console.log(
    `Estimate ${fmtDuration(etaSecs)} · ${a.parallel} · started (run "${a.name}", pid ${child.pid}, max ${fmtDuration(
      maxSecs,
    )})`,
  );
  console.log(`Next: runScript tick ${a.name}`);
  return 0;
}

function enforceMax(name: string, meta: Meta, now: number): boolean {
  const elapsed = (now - meta.startedAt) / 1000;
  if (elapsed > meta.max && isAlive(meta.pid) && !existsSync(exitCodePath(name))) {
    killGroup(meta.pid);
    writeFileSync(killedPath(name), `max ${meta.max}s exceeded\n`);
    return true;
  }
  return false;
}

function killGroup(pid: number): void {
  // Negative pid → whole process group (the detached session leader's group).
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-pid, sig);
    } catch {}
    try {
      process.kill(pid, sig);
    } catch {}
    if (sig === "SIGTERM") {
      // brief grace handled by caller cadence; SIGKILL follows on next pass
    }
  }
}

async function cmdTick(argv: string[]): Promise<number> {
  const name = argv[0];
  if (!name) {
    console.error("usage: runScript tick <name>");
    return 2;
  }
  const meta = readMeta(name);
  if (!meta) {
    console.error(`no such run: "${name}" (try: runScript list)`);
    return 2;
  }

  const deadline = Date.now() + TICK_MAX_MS;
  while (Date.now() < deadline) {
    const now = Date.now();
    maybeSample(name, now);

    if (enforceMax(name, meta, now)) break;

    const { state } = jobState(name, meta);
    if (state !== "running") break;

    await Bun.sleep(SAMPLE_EVERY_MS);
  }

  const now = Date.now();
  maybeSample(name, now);
  const snap = snapshot(name, meta, now);
  console.log(renderSnapshot(snap, meta));
  return snap.state === "running" || snap.state === "done" ? 0 : 1;
}

function cmdStatus(argv: string[]): number {
  const name = argv[0];
  if (!name) {
    console.error("usage: runScript status <name>");
    return 2;
  }
  const meta = readMeta(name);
  if (!meta) {
    console.error(`no such run: "${name}" (try: runScript list)`);
    return 2;
  }
  const now = Date.now();
  maybeSample(name, now);
  enforceMax(name, meta, now);
  const snap = snapshot(name, meta, now);
  console.log(renderSnapshot(snap, meta));
  return 0;
}

function cmdStop(argv: string[]): number {
  const name = argv[0];
  if (!name) {
    console.error("usage: runScript stop <name>");
    return 2;
  }
  const meta = readMeta(name);
  if (!meta) {
    console.error(`no such run: "${name}"`);
    return 2;
  }
  if (existsSync(exitCodePath(name)) && readFileSync(exitCodePath(name), "utf8").trim()) {
    console.log(`"${name}" already finished.`);
    return 0;
  }
  killGroup(meta.pid);
  writeFileSync(killedPath(name), "stopped by user\n");
  console.log(`Stopped "${name}" (pid ${meta.pid}). Checkpoint preserved — re-start to resume.`);
  return 0;
}

function cmdList(): number {
  if (!existsSync(RUNS_DIR)) {
    console.log("No runs in this project.");
    return 0;
  }
  const names = readdirSync(RUNS_DIR).filter((n) => existsSync(metaPath(n)));
  if (!names.length) {
    console.log("No runs in this project.");
    return 0;
  }
  const now = Date.now();
  console.log(`Runs in ${PROJECT_ROOT}:`);
  for (const name of names.sort()) {
    const meta = readMeta(name)!;
    const snap = snapshot(name, meta, now);
    const pct = snap.pct != null ? ` ${snap.pct}%` : "";
    const eta =
      snap.state === "running" && snap.etaSecs != null ? ` ETA ${fmtDuration(snap.etaSecs)}` : "";
    console.log(
      `  ${STATE_GLYPH[snap.state].padEnd(11)} ${name.padEnd(16)} elapsed ${fmtDuration(
        snap.elapsedSecs,
      ).padEnd(7)}${pct}${eta}`,
    );
  }
  return 0;
}

function cmdLogs(argv: string[]): number {
  const name = argv[0];
  if (!name) {
    console.error("usage: runScript logs <name> [--out|--err|--progress]");
    return 2;
  }
  if (!readMeta(name)) {
    console.error(`no such run: "${name}"`);
    return 2;
  }
  const which = argv.find((a) => a.startsWith("--"))?.slice(2) ?? "out";
  const file =
    which === "err"
      ? errPath(name)
      : which === "progress"
        ? progressPath(name)
        : which === "out"
          ? outPath(name)
          : null;
  if (!file) {
    console.error(`unknown stream "--${which}" (use --out, --err, or --progress)`);
    return 2;
  }
  if (!existsSync(file)) {
    console.log("(empty)");
    return 0;
  }
  process.stdout.write(readFileSync(file, "utf8"));
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────

const HELP = `runScript — background-job runner with a built-in heartbeat.

  runScript start <name> --eta <dur> --parallel "<how>" [--max <dur>] -- <command...>
  runScript tick   <name>     blocks until exit OR ~55s, then prints a snapshot
  runScript status <name>     non-blocking snapshot
  runScript stop   <name>     kill the detached job (checkpoint preserved)
  runScript list              runs in this project + status
  runScript logs   <name> [--out|--err|--progress]

Durations: 90s, 8m, 1h (bare number = seconds).
Loop:  start once → tick repeatedly (each ≤55s) → relay %/rate/ETA each cycle → stop when done.`;

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      return cmdStart(rest);
    case "tick":
      return await cmdTick(rest);
    case "status":
      return cmdStatus(rest);
    case "stop":
      return cmdStop(rest);
    case "list":
      return cmdList();
    case "logs":
      return cmdLogs(rest);
    case "help":
    case "--help":
    case "-h":
    case undefined:
      console.log(HELP);
      return cmd ? 0 : 1;
    default:
      console.error(`unknown command: "${cmd}"\n`);
      console.error(HELP);
      return 2;
  }
}

main().then((code) => process.exit(code));
