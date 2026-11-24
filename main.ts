// mend: apply an edit an AI model wrote to a tree of text files.
//
// One tool, four patch formats (unified diff, SEARCH/REPLACE blocks, V4A
// patches, JSON tool calls), three tiers of line matching, and an
// all-or-nothing write: either every edit applies and the tree is written,
// or every failure is reported and nothing is written. The contract is
// SPEC.md; this file implements it section by section.
//
// Node 22, standard library only. When MAKEFUN_ENV_URL is set the process
// is a trial runner instead of a CLI: the last lines hand over to
// runner.ts, which runs this same file once per check without the
// variable set.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

// ---------------------------------------------------------------- errors

/** A parse failure: exit 2 with `error: parse <line>`. */
class ParseFault extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/** One edit failed: an error code and the path the failure concerns. */
interface EditFailure {
  code: string;
  path: string;
}

// ------------------------------------------------------------------ tree

// The tree as the run sees it. Files are loaded from disk on first touch
// and kept as raw text; a path maps to null when it does not exist. The
// first-touch snapshot is remembered so the final report can compare the
// tree before the patch with the tree after it.
const state = new Map<string, string | null>();
const before = new Map<string, string | null>();
/** Successful move edits, for the `R <old> -> <new>` report lines. */
const moves: { from: string; to: string }[] = [];

function current(path: string): string | null {
  if (!state.has(path)) {
    let text: string | null = null;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      text = null;
    }
    state.set(path, text);
    before.set(path, text);
  }
  return state.get(path) ?? null;
}

function put(path: string, text: string | null): void {
  current(path);
  state.set(path, text);
}

// ----------------------------------------------------------------- lines

interface FileLines {
  lines: string[];
  /** The file's own line break. */
  brk: '\r\n' | '\n';
  /** Whether the file's text ends with a line break. */
  ends: boolean;
}

/** Split a file's text into lines by its own line break (SPEC section 3). */
function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], brk: '\n', ends: false };
  const first = text.indexOf('\n');
  const brk: '\r\n' | '\n' = first > 0 && text[first - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let ends = false;
  if (parts[parts.length - 1] === '') {
    ends = true;
    parts.pop();
  }
  return { lines: parts, brk, ends };
}

/** Join lines back with a break; a file of no lines is written empty. */
function joinFile(lines: string[], brk: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(brk) + (ends ? brk : '');
}

/** A patch's lines: split at \n, one trailing \r removed, no final piece. */
function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** The lines of a JSON string value, split the way patch lines are. */
function stringLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// ----------------------------------------------------------------- paths

/** A safe path (SPEC section 3). */
function isSafe(path: string): boolean {
  if (path === '' || path.startsWith('/') || path.includes('\\')) return false;
  return path.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// -------------------------------------------------------------- matching

type Tier = 0 | 1 | 2;

function atTier(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function linesMatch(fileLine: string, patLine: string, tier: Tier): boolean {
  return atTier(fileLine, tier) === atTier(patLine, tier);
}

/** Every start position at which O occurs in lines at the given tier. */
function occurrences(lines: string[], O: string[], tier: Tier): number[] {
  const out: number[] = [];
  if (O.length === 0 || O.length > lines.length) return out;
  for (let i = 0; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < O.length; j += 1) {
      if (!linesMatch(lines[i + j], O[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, and its positions. */
function findTier(
  lines: string[],
  O: string[],
  strict: boolean,
): { tier: Tier; at: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const at = occurrences(lines, O, tier);
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of N: its text, and for a context line its index into O. */
interface NLine {
  text: string;
  ctx: number; // index into O for a context line, -1 for an added line
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/**
 * Splice N over the matched lines at pos. Context lines are written as the
 * file's own matched lines; at tier 2 the other lines are re-indented from
 * O's first line's indent to the file's first matched line's indent.
 * Returns the number of lines written.
 */
function spliceMatch(
  file: FileLines,
  pos: number,
  O: string[],
  N: NLine[],
  tier: Tier,
): number {
  const out: string[] = [];
  const F = leadingWs(file.lines[pos] ?? '');
  const P = leadingWs(O[0] ?? '');
  for (const nl of N) {
    if (nl.ctx >= 0) {
      out.push(file.lines[pos + nl.ctx]);
    } else if (tier === 2 && nl.text.trim() !== '' && nl.text.startsWith(P)) {
      out.push(F + nl.text.slice(P.length));
    } else {
      out.push(nl.text);
    }
  }
  file.lines.splice(pos, O.length, ...out);
  return out.length;
}

// ----------------------------------------------------------------- edits

interface Edit {
  /** Every path the edit names, checked for safety before anything else. */
  paths: string[];
  /** Apply to the in-memory tree; return a failure or null on success. */
  run: () => EditFailure | null;
}

function unsafeFailure(edit: Edit): EditFailure | null {
  for (const p of edit.paths) {
    if (!isSafe(p)) return { code: 'unsafe', path: p };
  }
  return null;
}

// ------------------------------------------------------- unified (sec. 6)

interface UBodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  /** True when this context line came from an empty patch line. */
  fromEmpty: boolean;
}

interface UHunk {
  a: number;
  body: UBodyLine[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined; // undefined: no ---/+++ pair seen
  pairNew: string | null | undefined;
  renameFrom: string | null;
  renameTo: string | null;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: UHunk[];
}

/** The path of a --- or +++ line: after the marker, to a tab, trimmed. */
function headerPath(line: string): string | null {
  let s = line.slice(4);
  const tab = s.indexOf('\t');
  if (tab >= 0) s = s.slice(0, tab);
  s = s.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s;
}

function parseUnified(lines: string[]): Edit[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let hunk: UHunk | null = null;

  const endHunk = (): void => {
    if (hunk !== null && sec !== null) {
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1];
        if (last.kind === 'ctx' && last.fromEmpty) hunk.body.pop();
        else break;
      }
      sec.hunks.push(hunk);
    }
    hunk = null;
  };
  const endSection = (): void => {
    endHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
  };
  const newSection = (): USection => {
    endSection();
    sec = {
      gitOld: null,
      gitNew: null,
      pairOld: undefined,
      pairNew: undefined,
      renameFrom: null,
      renameTo: null,
      createFlag: false,
      deleteFlag: false,
      hunks: [],
    };
    return sec;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (hunk !== null) {
      const next = lines[i + 1];
      const endsBody =
        line.startsWith('diff --git ') ||
        (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ '));
      if (!endsBody) {
        if (line === '') {
          hunk.body.push({ kind: 'ctx', text: '', fromEmpty: true });
          continue;
        }
        const c = line[0];
        if (c === ' ') hunk.body.push({ kind: 'ctx', text: line.slice(1), fromEmpty: false });
        else if (c === '-') hunk.body.push({ kind: 'del', text: line.slice(1), fromEmpty: false });
        else if (c === '+') hunk.body.push({ kind: 'add', text: line.slice(1), fromEmpty: false });
        else if (c === '\\') hunk.body.push({ kind: 'bs', text: line, fromEmpty: false });
        else endHunk();
        if (hunk !== null) continue;
      } else {
        endHunk();
      }
    }
    // Outside a hunk body.
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      const s = newSection();
      s.gitOld = m[1];
      s.gitNew = m[2];
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseFault(i + 1);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      hunk = { a: Number(m[1]), body: [] };
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        if (sec !== null && sec.pairOld === undefined && sec.hunks.length === 0) {
          sec.pairOld = headerPath(line);
          sec.pairNew = headerPath(next);
        } else {
          const s = newSection();
          s.pairOld = headerPath(line);
          s.pairNew = headerPath(next);
        }
        i += 1;
        continue;
      }
      if (sec !== null && sec.hunks.length === 0) throw new ParseFault(i + 2);
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // Section header lines.
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.createFlag = true;
      else if (line.startsWith('deleted file mode')) sec.deleteFlag = true;
      // index, mode, similarity and any other lines are ignored.
    }
    // Anything else outside a body is ignored (prose, code fences).
  }
  endSection();

  const edits: Edit[] = [];
  for (const s of sections) {
    const oldPath =
      s.pairOld !== undefined ? s.pairOld : s.renameFrom !== null ? s.renameFrom : s.gitOld;
    const newPath =
      s.pairNew !== undefined ? s.pairNew : s.renameTo !== null ? s.renameTo : s.gitNew;
    edits.push(unifiedEdit(s, oldPath, newPath));
  }
  if (edits.length === 0) throw new ParseFault(1);
  return edits;
}

function unifiedEdit(sec: USection, oldPath: string | null, newPath: string | null): Edit {
  const paths: string[] = [];
  if (oldPath !== null) paths.push(oldPath);
  if (newPath !== null && newPath !== oldPath) paths.push(newPath);
  const isCreate = oldPath === null || sec.createFlag;
  const isDelete = !isCreate && (newPath === null || sec.deleteFlag);

  return {
    paths,
    run: () => {
      if (isCreate) {
        const target = newPath ?? oldPath;
        if (target === null) return { code: 'exists', path: '' };
        if (current(target) !== null) return { code: 'exists', path: target };
        const out: string[] = [];
        let lastAddBs = false;
        for (const h of sec.hunks) {
          for (let b = 0; b < h.body.length; b += 1) {
            const bl = h.body[b];
            if (bl.kind === 'add') {
              out.push(bl.text);
              lastAddBs = h.body[b + 1]?.kind === 'bs';
            }
          }
        }
        put(target, joinFile(out, '\n', !lastAddBs));
        return null;
      }
      if (oldPath === null) return { code: 'missing', path: newPath ?? '' };
      const text = current(oldPath);
      if (text === null) return { code: 'missing', path: oldPath };
      if (isDelete) {
        put(oldPath, null);
        return null;
      }
      if (newPath === null) return { code: 'missing', path: oldPath };
      const isMove = newPath !== oldPath;
      if (isMove && current(newPath) !== null) return { code: 'exists', path: newPath };
      const file = splitFile(text);
      const fail = applyHunks(file, sec.hunks, strictGlobal);
      if (fail !== null) return { code: fail, path: oldPath };
      const result = joinFile(file.lines, file.brk, file.ends);
      if (isMove) {
        put(newPath, result);
        put(oldPath, null);
        moves.push({ from: oldPath, to: newPath });
      } else {
        put(oldPath, result);
      }
      return null;
    },
  };
}

/** Apply a section's hunks in order; return a failure code or null. */
function applyHunks(file: FileLines, hunks: UHunk[], strict: boolean): string | null {
  let d = 0;
  for (const h of hunks) {
    const O: string[] = [];
    const N: NLine[] = [];
    // Whether a \ line follows the hunk's last context or + line.
    let bsAfterLastCtxAdd = false;
    for (let b = 0; b < h.body.length; b += 1) {
      const bl = h.body[b];
      if (bl.kind === 'ctx') {
        O.push(bl.text);
        N.push({ text: bl.text, ctx: O.length - 1 });
        bsAfterLastCtxAdd = h.body[b + 1]?.kind === 'bs';
      } else if (bl.kind === 'del') {
        O.push(bl.text);
      } else if (bl.kind === 'add') {
        N.push({ text: bl.text, ctx: -1 });
        bsAfterLastCtxAdd = h.body[b + 1]?.kind === 'bs';
      }
    }
    if (O.length === 0) {
      const at = Math.min(h.a + d, file.lines.length);
      const atEnd = at === file.lines.length;
      file.lines.splice(at, 0, ...N.map((n) => n.text));
      if (atEnd) file.ends = !bsAfterLastCtxAdd;
      d += N.length;
      continue;
    }
    const found = findTier(file.lines, O, strict);
    if (found === null) return 'no-match';
    const target = h.a - 1 + d;
    let pos = found.at[0];
    for (const p of found.at) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const runsToEnd = pos + O.length === file.lines.length;
    spliceMatch(file, pos, O, N, found.tier);
    if (runsToEnd) file.ends = !bsAfterLastCtxAdd;
    d += N.length - O.length;
  }
  return null;
}

// ------------------------------------------------- SEARCH/REPLACE (sec. 7)

const SR_SEARCH = '<<<<<<< SEARCH';
const SR_MID = '=======';
const SR_END = '>>>>>>> REPLACE';

function trimTrail(s: string): string {
  return s.replace(/\s+$/, '');
}

function parseSearchReplace(lines: string[]): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevPath: string | null = null;
  let rangeStart = 0; // first line index a path may be searched from
  let i = 0;
  while (i < lines.length) {
    if (trimTrail(lines[i]) !== SR_SEARCH) {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    // Find the ======= separator; a REPLACE marker, another SEARCH marker
    // or the end of the patch first means the block is malformed.
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = trimTrail(lines[j]);
      if (t === SR_MID) {
        eq = j;
        break;
      }
      if (t === SR_END || t === SR_SEARCH) break;
    }
    if (eq < 0) throw new ParseFault(searchLine);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      const t = trimTrail(lines[j]);
      if (t === SR_END) {
        rep = j;
        break;
      }
      if (t === SR_SEARCH) break;
    }
    if (rep < 0) throw new ParseFault(searchLine);
    // The path: the nearest line before the SEARCH line, at or after the
    // previous block's end, that is not blank and does not start with ```.
    let path: string | null = null;
    for (let m = i - 1; m >= rangeStart; m -= 1) {
      const t = lines[m].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFault(searchLine);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    rangeStart = rep + 1;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new ParseFault(1);
  return blocks.map((b) => ({
    paths: [b.path],
    run: (): EditFailure | null => {
      if (b.oldLines.length === 0) {
        if (current(b.path) !== null) return { code: 'exists', path: b.path };
        put(b.path, joinFile(b.newLines, '\n', true));
        return null;
      }
      const text = current(b.path);
      if (text === null) return { code: 'missing', path: b.path };
      const file = splitFile(text);
      const found = findTier(file.lines, b.oldLines, strictGlobal);
      if (found === null) return { code: 'no-match', path: b.path };
      if (found.at.length > 1) return { code: 'ambiguous', path: b.path };
      const N: NLine[] = b.newLines.map((t) => ({ text: t, ctx: -1 }));
      spliceMatch(file, found.at[0], b.oldLines, N, found.tier);
      put(b.path, joinFile(file.lines, file.brk, file.ends));
      return null;
    },
  }));
}

// ------------------------------------------------------------ V4A (sec. 8)

interface VChunk {
  anchor: string | null;
  eof: boolean;
  O: string[];
  N: NLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function parseV4a(lines: string[]): Edit[] {
  const isBlank = (s: string): boolean => s.trim() === '';
  let fb = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!isBlank(lines[i])) {
      fb = i;
      break;
    }
  }
  if (fb < 0) throw new ParseFault(1);
  if (lines[fb].trim() !== '*** Begin Patch') throw new ParseFault(fb + 1);
  let lb = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isBlank(lines[i])) {
      lb = i;
      break;
    }
  }
  if (lb < 0 || lines[lb].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);

  const sections: VSection[] = [];
  const sectionStart = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File: ')) return 'add';
    if (l.startsWith('*** Delete File: ')) return 'delete';
    if (l.startsWith('*** Update File: ')) return 'update';
    return null;
  };

  let i = fb + 1;
  while (i < lb) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const kind = sectionStart(line);
    if (kind === null) throw new ParseFault(i + 1);
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const headerLine = i + 1;
    i += 1;
    if (kind === 'add') {
      const body: { text: string; fromEmpty: boolean; wsLine: number }[] = [];
      while (i < lb && sectionStart(lines[i]) === null) {
        const l = lines[i];
        if (l.startsWith('+')) body.push({ text: l.slice(1), fromEmpty: false, wsLine: 0 });
        else if (l === '') body.push({ text: '', fromEmpty: true, wsLine: 0 });
        else if (l.trim() === '') body.push({ text: '', fromEmpty: true, wsLine: i + 1 });
        else throw new ParseFault(i + 1);
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1].fromEmpty) body.pop();
      for (const b of body) {
        if (b.wsLine !== 0) throw new ParseFault(b.wsLine);
      }
      sections.push({ kind, path, addLines: body.map((b) => b.text), moveTo: null, chunks: [] });
    } else if (kind === 'delete') {
      while (i < lb && sectionStart(lines[i]) === null) {
        if (!isBlank(lines[i])) throw new ParseFault(i + 1);
        i += 1;
      }
      sections.push({ kind, path, addLines: [], moveTo: null, chunks: [] });
    } else {
      const sec: VSection = { kind, path, addLines: [], moveTo: null, chunks: [] };
      // Chunk bodies are collected as raw items first, so the blank lines
      // at the end of the section can be dropped before O and N are built.
      interface VBody {
        kind: 'ctx' | 'del' | 'add';
        text: string;
        fromEmpty: boolean;
      }
      let chunk: { anchor: string | null; eof: boolean; body: VBody[] } | null = null;
      let sawContent = false;
      const endChunk = (atSectionEnd: boolean): void => {
        if (chunk === null) return;
        // Blank lines at the end of a section are not part of it: when the
        // section ends, drop the last chunk's trailing context lines that
        // came from blank patch lines.
        if (atSectionEnd) {
          while (chunk.body.length > 0) {
            const last = chunk.body[chunk.body.length - 1];
            if (last.kind === 'ctx' && last.fromEmpty) chunk.body.pop();
            else break;
          }
        }
        if (chunk.body.length === 0 && chunk.anchor === null && !chunk.eof) {
          chunk = null;
          return;
        }
        const O: string[] = [];
        const N: NLine[] = [];
        for (const b of chunk.body) {
          if (b.kind === 'ctx') {
            O.push(b.text);
            N.push({ text: b.text, ctx: O.length - 1 });
          } else if (b.kind === 'del') {
            O.push(b.text);
          } else {
            N.push({ text: b.text, ctx: -1 });
          }
        }
        sec.chunks.push({ anchor: chunk.anchor, eof: chunk.eof, O, N });
        chunk = null;
      };
      while (i < lb && sectionStart(lines[i]) === null) {
        const l = lines[i];
        if (!sawContent && l.startsWith('*** Move to: ')) {
          sec.moveTo = l.slice('*** Move to: '.length).trim();
          sawContent = true;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          endChunk(false);
          const anchor = l.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          sawContent = true;
          i += 1;
          continue;
        }
        if (l !== '' && !l.startsWith(' ') && !l.startsWith('-') && !l.startsWith('+') && l.trim() === '*** End of File') {
          if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
          chunk.eof = true;
          endChunk(false);
          sawContent = true;
          i += 1;
          continue;
        }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (chunk === null) chunk = { anchor: null, eof: false, body: [] };
          sawContent = true;
          if (l === '' || l.startsWith(' ')) {
            chunk.body.push({ kind: 'ctx', text: l === '' ? '' : l.slice(1), fromEmpty: l.trim() === '' });
          } else if (l.startsWith('-')) {
            chunk.body.push({ kind: 'del', text: l.slice(1), fromEmpty: false });
          } else {
            chunk.body.push({ kind: 'add', text: l.slice(1), fromEmpty: false });
          }
          i += 1;
          continue;
        }
        throw new ParseFault(i + 1);
      }
      endChunk(true);
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new ParseFault(headerLine);
      sections.push(sec);
    }
  }
  if (sections.length === 0) throw new ParseFault(1);
  return sections.map((s) => v4aEdit(s));
}

function v4aEdit(sec: VSection): Edit {
  const paths = sec.moveTo !== null && sec.moveTo !== sec.path ? [sec.path, sec.moveTo] : [sec.path];
  return {
    paths,
    run: (): EditFailure | null => {
      if (sec.kind === 'add') {
        if (current(sec.path) !== null) return { code: 'exists', path: sec.path };
        put(sec.path, joinFile(sec.addLines, '\n', true));
        return null;
      }
      const text = current(sec.path);
      if (text === null) return { code: 'missing', path: sec.path };
      if (sec.kind === 'delete') {
        put(sec.path, null);
        return null;
      }
      if (sec.moveTo !== null && current(sec.moveTo) !== null) {
        return { code: 'exists', path: sec.moveTo };
      }
      const file = splitFile(text);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          const at = findAnchor(file.lines, chunk.anchor, cursor, strictGlobal);
          if (at < 0) return { code: 'no-match', path: sec.path };
          cursor = at + 1;
        }
        if (chunk.O.length === 0) {
          const at = chunk.eof ? file.lines.length : cursor;
          file.lines.splice(at, 0, ...chunk.N.map((n) => n.text));
          cursor = at + chunk.N.length;
          continue;
        }
        const tiers: Tier[] = strictGlobal ? [0] : [0, 1, 2];
        let placed: { tier: Tier; pos: number } | null = null;
        for (const tier of tiers) {
          const at = occurrences(file.lines, chunk.O, tier).filter(
            (p) => p >= cursor && (!chunk.eof || p + chunk.O.length === file.lines.length),
          );
          if (at.length > 0) {
            placed = { tier, pos: at[0] };
            break;
          }
        }
        if (placed === null) return { code: 'no-match', path: sec.path };
        const written = spliceMatch(file, placed.pos, chunk.O, chunk.N, placed.tier);
        cursor = placed.pos + written;
      }
      const result = joinFile(file.lines, file.brk, file.ends);
      if (sec.moveTo !== null) {
        put(sec.moveTo, result);
        put(sec.path, null);
        moves.push({ from: sec.path, to: sec.moveTo });
      } else {
        put(sec.path, result);
      }
      return null;
    },
  };
}

/**
 * The first line at or after `from` equal to the anchor. Positions are
 * scanned in order; at each position the tiers are tried in order, so the
 * earliest position wins and the tier only breaks ties at one position.
 */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (let p = from; p < lines.length; p += 1) {
    for (const tier of tiers) {
      if (linesMatch(lines[p], anchor, tier)) return p;
    }
  }
  return -1;
}

// ----------------------------------------------------------- JSON (sec. 9)

interface JsonEdit {
  command: string;
  path: string;
  fileText?: string;
  oldStr?: string;
  newStr?: string;
  insertLine?: number;
}

function toJsonEdit(obj: unknown, line: number): JsonEdit {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new ParseFault(line);
  const o = obj as Record<string, unknown>;
  const command = o.command;
  const path = o.path;
  if (typeof command !== 'string' || typeof path !== 'string') throw new ParseFault(line);
  if (command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseFault(line);
    return { command, path, fileText: o.file_text };
  }
  if (command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseFault(line);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseFault(line);
    return { command, path, oldStr: o.old_str, newStr: (o.new_str as string | undefined) ?? '' };
  }
  if (command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) {
      throw new ParseFault(line);
    }
    if (typeof o.new_str !== 'string') throw new ParseFault(line);
    return { command, path, insertLine: o.insert_line, newStr: o.new_str };
  }
  throw new ParseFault(line);
}

function parseJson(text: string): Edit[] {
  const firstChar = /\S/.exec(text);
  const edits: JsonEdit[] = [];
  if (firstChar !== null && text[firstChar.index] === '[') {
    const startLine = text.slice(0, firstChar.index).split('\n').length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ParseFault(startLine);
    }
    if (!Array.isArray(parsed)) throw new ParseFault(startLine);
    for (const el of parsed) edits.push(toJsonEdit(el, startLine));
    if (edits.length === 0) throw new ParseFault(startLine);
  } else {
    const lines = patchLines(text);
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() === '') continue;
      let obj: unknown;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        throw new ParseFault(i + 1);
      }
      edits.push(toJsonEdit(obj, i + 1));
    }
    if (edits.length === 0) throw new ParseFault(1);
  }
  return edits.map((e) => jsonEdit(e));
}

/** Count overlapping occurrences of needle in hay. */
function countOccurrences(hay: string, needle: string): number {
  let n = 0;
  let at = hay.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = hay.indexOf(needle, at + 1);
  }
  return n;
}

/**
 * Replace the single occurrence of oldStr in a CRLF file's text. The text
 * and both strings are read with every \r\n as \n; on write-back the line
 * breaks that were \r\n in the original stay \r\n, a lone \n in the
 * original stays \n, and the inserted text's breaks are written \r\n.
 */
function crlfReplace(text: string, oldStr: string, newStr: string): string | EditFailure {
  // Normalise, remembering for each \n in the normalised text whether it
  // was a \r\n (true) or a lone \n (false) in the original.
  let norm = '';
  const nlKind = new Map<number, boolean>();
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\r' && text[i + 1] === '\n') {
      nlKind.set(norm.length, true);
      norm += '\n';
      i += 1;
    } else if (text[i] === '\n') {
      nlKind.set(norm.length, false);
      norm += '\n';
    } else {
      norm += text[i];
    }
  }
  const o = oldStr.replaceAll('\r\n', '\n');
  const n = newStr.replaceAll('\r\n', '\n');
  const count = countOccurrences(norm, o);
  if (count === 0) return { code: 'no-match', path: '' };
  if (count > 1) return { code: 'ambiguous', path: '' };
  const at = norm.indexOf(o);
  const head = norm.slice(0, at);
  const tail = norm.slice(at + o.length);
  // Rebuild: head keeps its original break kinds (positions unchanged),
  // the inserted text's breaks become \r\n, the tail's breaks keep their
  // original kinds (their positions shift by n.length - o.length).
  let out = '';
  for (let i = 0; i < head.length; i += 1) {
    out += head[i] === '\n' ? (nlKind.get(i) ? '\r\n' : '\n') : head[i];
  }
  out += n.replaceAll('\n', '\r\n');
  const shift = at + o.length;
  for (let i = 0; i < tail.length; i += 1) {
    out += tail[i] === '\n' ? (nlKind.get(shift + i) ? '\r\n' : '\n') : tail[i];
  }
  return out;
}

function jsonEdit(e: JsonEdit): Edit {
  return {
    paths: [e.path],
    run: (): EditFailure | null => {
      if (e.command === 'create') {
        if (current(e.path) !== null) return { code: 'exists', path: e.path };
        put(e.path, e.fileText ?? '');
        return null;
      }
      const text = current(e.path);
      if (text === null) return { code: 'missing', path: e.path };
      if (e.command === 'str_replace') {
        const oldStr = e.oldStr ?? '';
        const newStr = e.newStr ?? '';
        const file = splitFile(text);
        if (file.brk === '\r\n') {
          const r = crlfReplace(text, oldStr, newStr);
          if (typeof r !== 'string') return { code: r.code, path: e.path };
          put(e.path, r);
          return null;
        }
        const count = countOccurrences(text, oldStr);
        if (count === 0) return { code: 'no-match', path: e.path };
        if (count > 1) return { code: 'ambiguous', path: e.path };
        const at = text.indexOf(oldStr);
        put(e.path, text.slice(0, at) + newStr + text.slice(at + oldStr.length));
        return null;
      }
      // insert
      const file = splitFile(text);
      const at = e.insertLine ?? 0;
      if (at < 0 || at > file.lines.length) return { code: 'no-match', path: e.path };
      const add = stringLines(e.newStr ?? '');
      file.lines.splice(at, 0, ...add);
      put(e.path, joinFile(file.lines, file.brk, file.ends));
      return null;
    },
  };
}

// ------------------------------------------------------------- detection

function detectFormat(lines: string[]): string | null {
  const first = lines.find((l) => l.trim() !== '');
  if (first !== undefined && first.trim() === '*** Begin Patch') return 'v4a';
  if (first !== undefined) {
    const c = first.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  if (lines.some((l) => trimTrail(l) === SR_SEARCH)) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ------------------------------------------------------------------- CLI

let strictGlobal = false;

function fail2(line: string): number {
  process.stdout.write(`${line}\n`);
  return 2;
}

function main(): number {
  const args = process.argv.slice(2);
  let format = 'auto';
  let checkOnly = false;
  let strict = false;
  const seen = new Set<string>();
  const positional: string[] = [];
  let endOpts = false;
  for (const arg of args) {
    if (!endOpts && arg === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check' || arg === '--strict') {
        if (seen.has(arg)) return fail2('error: usage');
        seen.add(arg);
        if (arg === '--check') checkOnly = true;
        else strict = true;
      } else if (arg.startsWith('--format=')) {
        if (seen.has('--format')) return fail2('error: usage');
        seen.add('--format');
        const v = arg.slice('--format='.length);
        if (!['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(v)) {
          return fail2('error: usage');
        }
        format = v;
      } else {
        return fail2('error: usage');
      }
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 1) return fail2('error: usage');
  strictGlobal = strict;

  let patchText: string;
  const patchArg = positional[0];
  if (patchArg === undefined || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return fail2('error: no-patch');
    }
  }

  const lines = patchLines(patchText);
  let fmt = format;
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return fail2('error: format');
    fmt = detected;
  }

  // Parse the whole patch before any file is looked at: a parse error is
  // reported ahead of every per-edit failure.
  let edits: Edit[];
  try {
    if (fmt === 'unified') edits = parseUnified(lines);
    else if (fmt === 'search-replace') edits = parseSearchReplace(lines);
    else if (fmt === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(patchText);
  } catch (err) {
    if (err instanceof ParseFault) return fail2(`error: parse ${err.line}`);
    throw err;
  }
  const failures: EditFailure[] = [];
  for (const edit of edits) {
    const bad = unsafeFailure(edit);
    if (bad !== null) {
      failures.push(bad);
      continue;
    }
    const f = edit.run();
    if (f !== null) failures.push(f);
  }

  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    return 1;
  }

  // Report the changes, in byte order of the paths.
  interface Change {
    key: string;
    line: string;
  }
  const changes: Change[] = [];
  const suppressed = new Set<string>();
  for (const mv of moves) {
    const oldBefore = before.get(mv.from);
    const oldAfter = state.get(mv.from);
    const newBefore = before.get(mv.to);
    const newAfter = state.get(mv.to);
    if (
      oldBefore !== null &&
      oldBefore !== undefined &&
      (oldAfter === null || oldAfter === undefined) &&
      (newBefore === null || newBefore === undefined) &&
      newAfter !== null &&
      newAfter !== undefined &&
      !suppressed.has(mv.from) &&
      !suppressed.has(mv.to)
    ) {
      changes.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
      suppressed.add(mv.from);
      suppressed.add(mv.to);
    }
  }
  for (const [path, orig] of before) {
    if (suppressed.has(path)) continue;
    const now = state.get(path) ?? null;
    if (orig === null && now !== null) changes.push({ key: path, line: `A ${path}` });
    else if (orig !== null && now === null) changes.push({ key: path, line: `D ${path}` });
    else if (orig !== null && now !== null && orig !== now) {
      changes.push({ key: path, line: `M ${path}` });
    }
  }
  changes.sort((a, b) => Buffer.from(a.key, 'utf8').compare(Buffer.from(b.key, 'utf8')));

  if (!checkOnly) {
    for (const [path, orig] of before) {
      const now = state.get(path) ?? null;
      if (orig === now) continue;
      if (now === null) {
        rmSync(path, { force: true });
      } else {
        const dir = dirname(path);
        if (dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(path, now);
      }
    }
  }

  let out = '';
  for (const c of changes) out += `${c.line}\n`;
  out += changes.length === 1 ? 'ok: 1 file\n' : `ok: ${changes.length} files\n`;
  process.stdout.write(out);
  return 0;
}

// -------------------------------------------------------------- handover

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  process.exitCode = main();
}
