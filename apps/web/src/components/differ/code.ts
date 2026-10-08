// Symbol code hunks, vendored from the differ project (differ/lib/code.ts)
// onto the differ-tree-view branch. Verbatim logic; exercised once the
// symbol-enrichment service lands (see DifferTreeView.tsx).
// Slice a symbol's exact line range out of a fetched file and align old vs
// new into side-by-side rows. Only the hunk related to the symbol is ever
// shown — never the whole file.
import { parseDiffFromFile } from "@pierre/diffs";
import type { Status } from "./rows";

// jsdiff (behind pierre's parseDiffFromFile) trims hunks to ±`context`
// lines, stashing the edges in collapsedBefore/After regions that the
// overlay renderer must then re-expand. Our overlay shifts hunk starts to
// absolute file lines, which corrupts exactly that trailing-region math
// (absolute start vs snippet length → negative remainder → trailing line
// never renders: every window ran one row short). Parsing with full context
// keeps every line inside a hunk, so the region logic stays idle and the
// shift is safe. MUST be used for every parse whose rows feed the overlay.
export const DIFF_CONTEXT = 1_000_000_000;
const PARSE_OPTS = { context: DIFF_CONTEXT };

export interface CodeLine {
  status: Status;
  oldNo: number | null;
  oldText: string | null;
  newNo: number | null;
  newText: string | null;
}

// One unfolded symbol: the aligned rows (one slot per split line) plus the raw snippets the overlay renders.
export interface ExpandedHunk {
  lines: CodeLine[];
  oldSnippet: string | null;
  newSnippet: string | null;
  oldStart?: number | null;
  newStart?: number | null;
  // Collapsed-gap indices (into hunkGaps) the user has expanded. Absent =
  // everything beyond the context padding stays collapsed behind gap rows.
  expanded?: Set<number>;
}

// Context padding around each change: expanding a file or symbol shows only
// changed lines plus this many unchanged lines above/below, the rest behind
// clickable "N unmodified lines" gaps (GitHub-style).
export const HUNK_CONTEXT = 5;

export interface HunkGap {
  start: number; // inclusive index into lines
  end: number; // exclusive
}

export type HunkBlock =
  | { kind: "show"; start: number; end: number }
  | { kind: "gap"; start: number; end: number; gapIdx: number };

/** Hidden line ranges: everything outside HUNK_CONTEXT of a changed line. */
export function hunkGaps(lines: CodeLine[], context: number = HUNK_CONTEXT): HunkGap[] {
  const n = lines.length;
  if (n === 0) return [];
  const wins: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    // T3 strictness: i is bounded by lines.length.
    if (lines[i]!.status === "same") continue;
    wins.push([Math.max(0, i - context), Math.min(n, i + context + 1)]);
  }
  if (wins.length === 0) return [];
  wins.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
  // T3 strictness: length checks above prove these tuple slots exist.
  const merged: [number, number][] = [wins[0]!];
  for (let k = 1; k < wins.length; k++) {
    const last = merged[merged.length - 1]!;
    const w = wins[k]!;
    if (w[0]! <= last[1]!) last[1] = Math.max(last[1]!, w[1]!);
    else merged.push(w);
  }
  const gaps: HunkGap[] = [];
  if (merged[0]![0]! > 0) gaps.push({ start: 0, end: merged[0]![0]! });
  for (let k = 1; k < merged.length; k++)
    gaps.push({ start: merged[k - 1]![1]!, end: merged[k]![0]! });
  const lastW = merged[merged.length - 1]!;
  if (lastW[1]! < n) gaps.push({ start: lastW[1]!, end: n });
  return gaps;
}

/** Visible line blocks + collapsed gaps for a hunk. Gap indices are stable
 *  (position among all gaps), so expanding one never renumbers the rest.
 *  Expanded gaps MERGE into their neighboring windows: a standalone
 *  pure-context window would diff to zero hunks, which the overlay renders
 *  as nothing (blank rows), so every emitted show block contains a change
 *  except in the degenerate all-unchanged hunk. */
export function hunkBlocks(
  lines: CodeLine[],
  context: number = HUNK_CONTEXT,
  expanded?: Set<number>,
): HunkBlock[] {
  const gaps = hunkGaps(lines, context);
  if (gaps.length === 0)
    return lines.length > 0 ? [{ kind: "show", start: 0, end: lines.length }] : [];
  return buildBlocks(
    gaps,
    lines.length,
    new Set(gaps.map((_, i) => i).filter((i) => !expanded?.has(i))),
  );
}

function buildBlocks(gaps: HunkGap[], total: number, kept: Set<number>): HunkBlock[] {
  const out: HunkBlock[] = [];
  let showStart = 0;
  gaps.forEach((g, idx) => {
    if (!kept.has(idx)) return; // expanded/dropped: absorbed into the open show run
    if (g.start > showStart) out.push({ kind: "show", start: showStart, end: g.start });
    out.push({ kind: "gap", start: g.start, end: g.end, gapIdx: idx });
    showStart = g.end;
  });
  if (showStart < total) out.push({ kind: "show", start: showStart, end: total });
  return out;
}

/** True when re-diffing a visible window reproduces its slot rows exactly
 *  (same count, same statuses). The overlay diffs each window on its own,
 *  and on repetitive content (Cargo.lock) that diff can align lines
 *  differently than the full-file diff the slots came from — then every
 *  overlay row below drifts off its slot. */
function verifyWindow(lines: CodeLine[], start: number, end: number): boolean {
  const w = windowSnippets(lines, start, end);
  const re = alignCode(w.old, w.new, w.oldStart ?? 1, w.newStart ?? 1);
  if (re.length !== end - start) return false;
  for (let i = 0; i < re.length; i++) if (re[i]!.status !== lines[start + i]!.status) return false;
  return true;
}

/** Gap-collapsed blocks, verified window by window: any window whose
 *  re-diff would misalign its overlay drops its neighboring gaps (shows
 *  more) until every window is exact. Fail safe is the whole hunk shown —
 *  always aligned, just uncollapsed. Every consumer (tree slots, overlay,
 *  counts) must use this, never hunkBlocks directly, or the layers disagree
 *  on row geometry. */
export function safeHunkBlocks(
  lines: CodeLine[],
  context: number = HUNK_CONTEXT,
  expanded?: Set<number>,
): HunkBlock[] {
  const gaps = hunkGaps(lines, context);
  if (gaps.length === 0)
    return lines.length > 0 ? [{ kind: "show", start: 0, end: lines.length }] : [];
  const kept = new Set(gaps.map((_, i) => i).filter((i) => !expanded?.has(i)));
  for (;;) {
    // No gaps left: one window over everything re-diffs to the diff the
    // slots came from, so it verifies by construction.
    if (kept.size === 0)
      return lines.length > 0 ? [{ kind: "show", start: 0, end: lines.length }] : [];
    const blocks = buildBlocks(gaps, lines.length, kept);
    let dropped = false;
    for (const b of blocks) {
      if (b.kind !== "show" || verifyWindow(lines, b.start, b.end)) continue;
      gaps.forEach((g, i) => {
        if (kept.has(i) && (g.end === b.start || g.start === b.end)) {
          kept.delete(i);
          dropped = true;
        }
      });
    }
    if (!dropped) return blocks;
  }
}
/** Rows the tree reserves for a hunk: visible lines + one row per collapsed gap. */
export function hunkVisibleCount(
  lines: CodeLine[],
  context: number = HUNK_CONTEXT,
  expanded?: Set<number>,
): number {
  let n = 0;
  for (const b of safeHunkBlocks(lines, context, expanded))
    n += b.kind === "show" ? b.end - b.start : 1;
  return n;
}

/** Rebuild the old/new snippets for one visible window, for the overlay to
 *  diff on its own. Null side = window has no lines on that side. The join
 *  always ends with a newline: pierre parses trailing-newline-terminated
 *  text, so a window ending on a blank line would otherwise lose its last
 *  row and every overlay row below would drift one slot up. */
export function windowSnippets(
  lines: CodeLine[],
  start: number,
  end: number,
): { old: string | null; new: string | null; oldStart: number | null; newStart: number | null } {
  const olds: string[] = [];
  const news: string[] = [];
  let oldStart: number | null = null;
  let newStart: number | null = null;
  for (let i = start; i < end; i++) {
    // T3 strictness: the window is inside lines by construction.
    const l = lines[i]!;
    if (l.oldText != null) {
      if (oldStart == null) oldStart = l.oldNo ?? null;
      olds.push(l.oldText);
    }
    if (l.newText != null) {
      if (newStart == null) newStart = l.newNo ?? null;
      news.push(l.newText);
    }
  }
  return {
    old: olds.length > 0 ? `${olds.join("\n")}\n` : null,
    new: news.length > 0 ? `${news.join("\n")}\n` : null,
    oldStart,
    newStart,
  };
}

/** 1-based inclusive slice of file lines. */
export function sliceLines(text: string, start: number, end: number): string {
  return text
    .split("\n")
    .slice(Math.max(0, start - 1), Math.max(0, end))
    .join("\n");
}

interface HunkItem {
  type: string;
  lines?: number;
  additions?: number;
  deletions?: number;
  additionLineIndex?: number;
  deletionLineIndex?: number;
}

/** Align two snippets into row pairs. Line numbers are absolute (offset by
 * the snippet starts). Null on one side = added/deleted file or symbol. */
export function alignCode(
  oldSnippet: string | null,
  newSnippet: string | null,
  oldStart: number,
  newStart: number,
): CodeLine[] {
  if (oldSnippet == null && newSnippet == null) return [];
  if (oldSnippet == null) {
    return linesOf(newSnippet!).map((t, i) => ({
      status: "add" as Status,
      oldNo: null,
      oldText: null,
      newNo: newStart + i,
      newText: t,
    }));
  }
  if (newSnippet == null) {
    return linesOf(oldSnippet).map((t, i) => ({
      status: "del" as Status,
      oldNo: oldStart + i,
      oldText: t,
      newNo: null,
      newText: null,
    }));
  }
  const d = parseDiffFromFile(
    { name: "old", contents: oldSnippet },
    { name: "new", contents: newSnippet },
    PARSE_OPTS,
  );
  const adds = d.additionLines.map(clean);
  const dels = d.deletionLines.map(clean);
  const out: CodeLine[] = [];
  const ctx = (a: number, o: number) =>
    // T3 strictness: short lines read as empty rather than undefined.
    out.push({
      status: "same",
      oldNo: oldStart + o,
      oldText: dels[o] ?? null,
      newNo: newStart + a,
      newText: adds[a] ?? null,
    });
  let pa = 0;
  let po = 0;
  for (const h of d.hunks) {
    // Unchanged gap between hunks (diff context window split them): pair up.
    const ha = h.additionStart - 1;
    const ho = h.deletionStart - 1;
    while (pa < ha && po < ho) {
      ctx(pa, po);
      pa++;
      po++;
    }
    for (const c of h.hunkContent as HunkItem[]) {
      if (c.type === "context") {
        for (let k = 0; k < (c.lines ?? 0); k++)
          ctx((c.additionLineIndex ?? 0) + k, (c.deletionLineIndex ?? 0) + k);
        pa = (c.additionLineIndex ?? 0) + (c.lines ?? 0);
        po = (c.deletionLineIndex ?? 0) + (c.lines ?? 0);
      } else {
        // Paired, split-style: min() pairs read as one mod row (old on
        // the left, new on the right), the remainder as del/add rows, so
        // the rows match a split diff row-for-row (the overlay renders split).
        const nd = c.deletions ?? 0;
        const na = c.additions ?? 0;
        const n = Math.min(nd, na);
        for (let k = 0; k < n; k++) {
          const o = (c.deletionLineIndex ?? 0) + k;
          const a = (c.additionLineIndex ?? 0) + k;
          out.push({
            status: "mod",
            oldNo: oldStart + o,
            oldText: dels[o] ?? null,
            newNo: newStart + a,
            newText: adds[a] ?? null,
          });
        }
        for (let k = n; k < nd; k++) {
          const o = (c.deletionLineIndex ?? 0) + k;
          out.push({
            status: "del",
            oldNo: oldStart + o,
            oldText: dels[o] ?? null,
            newNo: null,
            newText: null,
          });
        }
        for (let k = n; k < na; k++) {
          const a = (c.additionLineIndex ?? 0) + k;
          out.push({
            status: "add",
            oldNo: null,
            oldText: null,
            newNo: newStart + a,
            newText: adds[a] ?? null,
          });
        }
        pa = (c.additionLineIndex ?? 0) + (c.additions ?? 0);
        po = (c.deletionLineIndex ?? 0) + (c.deletions ?? 0);
      }
    }
  }
  while (pa < adds.length && po < dels.length) {
    ctx(pa, po);
    pa++;
    po++;
  }
  while (po < dels.length) {
    out.push({
      status: "del",
      oldNo: oldStart + po,
      oldText: dels[po] ?? null,
      newNo: null,
      newText: null,
    });
    po++;
  }
  while (pa < adds.length) {
    out.push({
      status: "add",
      oldNo: null,
      oldText: null,
      newNo: newStart + pa,
      newText: adds[pa] ?? null,
    });
    pa++;
  }
  return out;
}

function linesOf(t: string): string[] {
  const ls = t.split("\n");
  if (ls.length && ls[ls.length - 1] === "") ls.pop();
  return ls;
}

// Parsed diff lines keep their terminator; code rows render one line each.
function clean(s: string): string {
  return s.replace(/\r?\n$/, "");
}
