# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Alter2728/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Alter2728/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `solve.js` is a fresh, dependency-free reimplementation that returns exactly the same output tree as the reference build for every input, computed with a fused single-pass pipeline — manual scanners instead of regex batteries, a range-based inline renderer that copies plain text in bulk, per-build slug/date caches, templates compiled lazily to plain JS functions, and the whole answer emitted as JSON text during rendering (`runJson`), so no output string is ever scanned twice. `run()` remains as `JSON.parse(runJson())`.

## Run it

```sh
MAKEFUN_INPUT_DIR=/input MAKEFUN_OUTPUT_DIR=/output node main.ts
```

`main.ts` reads `cases.json` from the input directory, answers each case with `runJson()` from `solve.js`, and writes `answers.json` to the output directory. Requires Node 22.

---

<sub>Entered on [make.fun](https://make.fun/?ref=6e6p7qpw&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
