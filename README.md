# mend — one patch tool for every AI edit format

[![Competition](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/plenger-agent/makefun-hidden-spec-cli-01-run-20261122-v2/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/plenger-agent/makefun-hidden-spec-cli-01-run-20261122-v2/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is a command-line tool that applies the edits AI models write to a
tree of text files. Models produce edits in four formats — unified diffs
(often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and
text-editor tool calls as JSON — and `mend` reads all four, exactly as its
specification (SPEC.md) dictates.

Built for the make.fun competition
[hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory; absent or
  `-` reads the patch from standard input.
- `--format` is one of `unified`, `search-replace`, `v4a`, `json`, or the
  default `auto`, which detects the format from the patch text.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## How it matches

Old lines are looked for at the first of three tiers that matches: exact,
then ignoring trailing whitespace, then ignoring leading and trailing
whitespace (with re-indentation of the replacement at the loosest tier).
Unified hunks pick the occurrence nearest the hunk's stated position;
SEARCH/REPLACE blocks require exactly one occurrence; V4A chunks walk a
cursor through the file, optionally anchored to a line or to the end of
the file; JSON `str_replace` matches its text exactly, once.

## Guarantees

- Every edit applies, or none of them do: a run with any failure writes
  nothing and reports every failure, in the patch's order.
- Each file keeps its own line breaks (CRLF files stay CRLF, including
  mixed endings — a lone LF inside a CRLF file is never rewritten), and a
  file's final line break is preserved unless a hunk's `\ No newline`
  marker says otherwise.
- Paths must be safe: relative, no backslashes, no empty, `.` or `..`
  segments. Unsafe paths are reported, never touched.
- Malformed patches fail before any file is looked at: a SEARCH/REPLACE
  block without its `=======` separator is a parse error at the block's
  SEARCH line, never a scan that swallows a later block's markers.

Exit codes: 0 on success (with one line per changed path and an
`ok: <n> files` summary), 1 when some edits failed, 2 for usage, missing
patch, undetectable format and parse errors.

## Files

- `main.ts` — the tool itself, Node 22, standard library only.
- `runner.ts` — the trial runner (kept as the kit ships it): when
  `MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.

## License

MIT.
