// Driver for the site-generator-speed entry: it reads every case from
// /input/cases.json, answers each one alone with run() from solve.js, and
// writes /output/answers.json. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// V8 is tuned before solve.js is imported, so all of the work runs under
// these flags (the house baseline runs with incremental marking off, and an
// entry may tune the flags the same way):
//   --no-incremental-marking: the baseline's own setting.
//   --no-opt: the optimizing compiler's background work costs more CPU than
//     its faster code saves on this workload, so it stays off. Measured
//     locally: total process CPU fell about a third with it off, and the
//     wall time fell too.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

for (const flag of ['--no-incremental-marking', '--no-opt']) {
  try {
    setFlagsFromString(flag);
  } catch {
    // A runtime that refuses a flag still runs the entry, just slower.
  }
}

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
