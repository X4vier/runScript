#!/usr/bin/env bun
// Demo job for runScript: processes N fake units with bounded concurrency,
// emitting progress + checkpointing after each so a kill/restart resumes.
//
//   runScript start demo --eta 30s --parallel "mapLimit 4 over 20 units" -- \
//     bun examples/demo.ts 20
//
// Then loop `runScript tick demo` and watch %/rate/ETA climb.

import { progress, checkpoint, mapLimit } from "../helpers/runScript.ts";

const total = Number(process.argv[2] ?? 20);
const perUnitMs = Number(process.argv[3] ?? 1000);

const units = Array.from({ length: total }, (_, i) => `unit-${i}`);

const p = progress("demo");
const ck = checkpoint<{ done: string[] }>("demo", { done: [] });
if (ck.resumed) console.log(`resuming — ${ck.state.done.length} already done`);

const todo = units.filter((u) => !ck.state.done.includes(u));
p.setTotal(todo.length);

await mapLimit(todo, 4, async (u) => {
  // Simulated idempotent work unit (pretend this is an UPSERT).
  await Bun.sleep(perUnitMs);
  ck.state.done.push(u);
  ck.save();
  p.tick(u);
  console.log(`processed ${u}`);
});

p.finish();
ck.clear();
console.log("done");
