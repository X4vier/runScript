// runScript TypeScript helper (Bun). Prefer this over Python.
//
// progress()   = single OVERWRITTEN line a watcher can cheaply read.
// checkpoint() = on-disk resume state (idempotent loop body → clean restart).
// mapLimit()   = bounded concurrency (the right way to parallelize I/O work).
//
// When launched by runScript, progress goes to $RUNSCRIPT_PROGRESS and state to
// $RUNSCRIPT_RUN_DIR. Run standalone, it falls back to a local .progress/ dir —
// so the same script works in both contexts.

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const DIR = process.env.RUNSCRIPT_RUN_DIR ?? new URL("./.progress/", import.meta.url).pathname;
const path = (n: string) => `${DIR.replace(/\/?$/, "/")}${n}`;
const ensure = () => mkdirSync(DIR, { recursive: true });

export function progress(name: string) {
  ensure();
  // Engine progress contract: "<done> <total> <message>" — done+total MUST come
  // first. The extra fields (%, elapsed, eta) are a human-readable bonus the
  // engine ignores; it computes its own rate/ETA from timestamped samples.
  const file = process.env.RUNSCRIPT_PROGRESS ?? path(`${name}.progress`);
  const start = performance.now();
  let total = 0,
    done = 0;
  const flush = (msg: string) => {
    const secs = (performance.now() - start) / 1000;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const eta = done && total ? `~${Math.round((secs / done) * (total - done))}s left` : "~?s left";
    writeFileSync(
      file,
      `${done} ${total} ${pct}% ${secs.toFixed(0)}s ${eta}${msg ? ` — ${msg}` : ""}\n`,
    );
  };
  return {
    file,
    setTotal: (n: number) => {
      total = n;
      flush("starting");
    },
    tick: (msg = "") => {
      done++;
      flush(msg);
    },
    finish: (msg = "complete") => {
      done = total || done;
      flush(msg);
    },
  };
}

export function checkpoint<T>(name: string, initial: T) {
  ensure();
  const file = path(`${name}.checkpoint.json`);
  const state: T = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : initial;
  return {
    state,
    resumed: existsSync(file),
    save: () => writeFileSync(file, JSON.stringify(state, null, 2)),
    clear: () => {
      if (existsSync(file)) rmSync(file);
    },
  };
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
