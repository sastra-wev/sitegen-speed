# sitegen-speed

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/sastra-wev/sitegen-speed/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/sastra-wev/sitegen-speed/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for **makefun-site 1.0.0**, make.fun's own static
site generator. `solve.js` exports `run(input)`, which returns exactly the
output tree makefun-site's `build` returns for the same input — every page's
`index.html`, the index and tag pages, `build-report.txt` and each static
file, byte for byte — and `main.ts` is the harness driver that answers every
case in `/input/cases.json` into `/output/answers.json`.

## How it is faster

Same semantics, cheaper machinery:

- **Markdown in one fused pass.** Blocks are lexed and rendered together —
  no token objects — with first-character dispatch instead of a regex per
  line, and the inline parser works over ranges of the original string
  instead of slicing a copy for every construct. Plain text is escaped in
  bulk runs, not character by character through a callback.
- **Templates compiled to JavaScript.** Each parsed template becomes a
  generated function that pushes chunks into one shared output array, with
  scope lookups specialised for one- and two-name paths and the escaping of
  repeated values (the site title, the recent posts, the tags) cached.
- **Cached slugs and dates.** Slugs (NFKD + mark-stripping) and long dates
  repeat heavily inside one site — tag names, respelled titles, reused
  headings — so both are memoised per build, with an ASCII fast path that
  skips normalisation entirely.
- **Front matter without the split.** Only the lines up to the closing
  `---` are scanned; the body is a single slice, and line endings are
  normalised only when a `\r` is actually present.
- **Word counting without allocation.** `reading_minutes` counts runs of
  non-whitespace with a table lookup instead of a global regex match — and
  is skipped entirely when no template path names it.

Round 2 adds:

- **One escape table for every escaper.** HTML escaping and the inline
  parser's plain runs read a single per-code-unit table instead of compare
  chains, so plain text is classified with one array load per character.
- **Slugs by runs.** The slug rule is evaluated over maximal runs of
  keepable characters, lowered as one slice per run, instead of a string
  concatenation per character.
- **Word counting in the regex engine.** The whitespace set `wordsOf`
  recognises is exactly JavaScript's `\s`, so the count is the whitespace
  runs a word follows, plus a word at the start — the same count, scanned
  by the regex engine rather than a per-character loop.
- **Memoised link resolution.** A (directory, target) pair resolves the
  same way from every source in that directory, so each distinct pair is
  resolved once per build; broken links are still reported per source.
- **A larger semi-space.** The driver raises V8's semi-space to 16 MB:
  the build churns many short-lived strings, and fewer, fuller scavenges
  cost less CPU than many small ones.

Everything is per-call state: cases are answered one at a time with nothing
carried from one to the next, and the output is a pure function of the
input.

## Verified

- Byte-identical to makefun-site 1.0.0 on the kit's practice set (the
  scorer passes 3/3) and on 67 freshly drawn generator sets (201 cases),
  plus hand-built edge cases: unparseable templates, refused front matter,
  shadowed statics, include loops, unicode slugs.
- Deterministic: two executions write byte-identical `answers.json`.
- Locally (one pinned CPU, same machine, practice set): about **2.6×**
  less CPU time in `run()` than the reference build.
- Round 2: byte-identical again on the practice set (kit grade-local
  passes 3/3), on 70 freshly drawn generator sets (210 cases) and on the
  edge cases; the rewritten word counter and slug rule each agree with
  the round-1 implementations on tens of thousands of random strings,
  Unicode whitespace and slugs included. Full-process CPU on the practice
  set drops by roughly a tenth against round 1, measured interleaved on
  one pinned CPU.

## Run it

```sh
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

Reads `cases.json` from the input directory, writes `answers.json` to the
output directory. Node 22, no dependencies.
