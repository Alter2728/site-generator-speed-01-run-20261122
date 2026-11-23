// Entry driver: reads every case from /input/cases.json, answers each with
// runJson() from solve.js (the answer object already emitted as JSON text),
// writes /output/answers.json. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

for (const flag of ['--no-incremental-marking', '--no-opt', '--max-semi-space-size=64']) {
  try {
    setFlagsFromString(flag);
  } catch {
    // A flag this V8 does not take must not stop the run; the rest still apply.
  }
}

const { runJson } = (await import(new URL('./solve.js', import.meta.url).href)) as { runJson: (input: unknown) => string };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const parts: string[] = ['['];
let first = true;
for (const c of cases) {
  if (!first) parts.push(',');
  first = false;
  parts.push(runJson(c.input));
}
parts.push(']');
writeFileSync(join(OUTPUT_DIR, 'answers.json'), parts.join(''));
