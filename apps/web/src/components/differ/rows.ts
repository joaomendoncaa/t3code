// Pure row builder + filters, vendored from the differ project
// (differ/lib/rows.ts) onto the differ-tree-view branch. Verbatim logic;
// T3 adaptation lives in DifferTreeView.tsx.
// Ports tree_diff.py build_rows, corrected: symbols pair by name
// (path::name), not by kind sequence.

export type Status = "same" | "add" | "del" | "mod" | "moved";

export interface FileEntry {
  path: string;
  status: string; // Added|Modified|Deleted|Renamed|Unchanged
}

export interface Symbol {
  id: string; // path::name
  file: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  // Old-rev position when the symbol exists there too (Modified/Unchanged).
  // Absent for Added, and for cached payloads predating the field.
  old_start_line?: number | null;
  old_end_line?: number | null;
  status: string; // Added|Modified|Deleted|Unchanged
}

export interface Cell {
  label: string;
  path: string;
  depth: number;
  isFile: boolean;
  isFolder?: boolean;
  kind?: string;
  startLine?: number;
  endLine?: number;
  // A code slot reserving one row per hunk line under its symbol. The
  // pierre-rendered hunk node paints the actual code over the slot range;
  // the canvas only tints slots by status.
  isCode?: boolean;
  // A collapsed run of unchanged lines ("N unmodified lines"): one slot per
  // hidden range, click to expand. Always a same-status row with both sides.
  isGap?: boolean;
  gapCount?: number;
  gapIdx?: number;
  icon?: string; // Material Icon Theme name for files/folders (set by the server)
}

export interface Row {
  left: Cell | null;
  right: Cell | null;
  status: Status;
}

export interface Spec {
  files: FileEntry[];
  symbols: Symbol[];
}

const KIND_PRE: Record<string, string> = {
  fn: "fn ",
  struct: "struct ",
  enum: "enum ",
  trait: "trait ",
  mod: "mod ",
  class: "class ",
  var: "var ",
  type: "type ",
  const: "const ",
  static: "static ",
  use: "use ",
};

function symLabel(s: Symbol): string {
  return `${KIND_PRE[s.kind] ?? s.kind + " "}${s.name}`;
}

function base(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function fileCell(path: string): Cell {
  return { label: base(path), path, depth: path.split("/").length - 1, isFile: true };
}

function dirCell(dir: string): Cell {
  return {
    label: base(dir) + "/",
    path: dir,
    depth: dir.split("/").length - 1,
    isFile: false,
    isFolder: true,
  };
}

function symCell(s: Symbol): Cell {
  return {
    label: symLabel(s),
    path: s.file,
    depth: s.file.split("/").length,
    isFile: false,
    kind: s.kind,
    startLine: s.start_line,
    endLine: s.end_line,
  };
}

// The spec carries new-rev positions on the symbol; the left (old) cell of
// a surviving symbol must point at its old-rev range instead, or slicing
// the old file lands on shifted lines.
function oldSymCell(s: Symbol): Cell {
  const c = symCell(s);
  if (s.old_start_line != null) c.startLine = s.old_start_line;
  if (s.old_end_line != null) c.endLine = s.old_end_line;
  return c;
}

function toRowStatus(st: string): Status {
  const l = st.toLowerCase();
  if (l === "added" || l === "add") return "add";
  if (l === "deleted" || l === "del") return "del";
  if (l === "modified" || l === "mod") return "mod";
  if (l === "renamed" || l === "moved") return "moved";
  return "same";
}

/** Parse `git diff --find-renames --name-status` R-lines into old->new map. */
export function parseRenames(nameStatus: string): Map<string, string> {
  const ren = new Map<string, string>();
  for (const line of nameStatus.split("\n")) {
    const parts = line.split("\t");
    if (parts[0]?.startsWith("R") && parts.length >= 3) {
      // T3 strictness: length check above proves these exist.
      const o = parts[1]!;
      const n = parts[2]!;
      ren.set(o, n);
    }
  }
  return ren;
}

/** GitHub-style path order: per directory level, subdirs first, then files,
 * each group alphabetical (code-unit, like `git ls-tree` / GitHub).
 * Flat file sort with this comparator yields DFS tree order. */
export function compareGitHub(a: string, b: string): number {
  if (a === b) return 0;
  const as = a.split("/");
  const bs = b.split("/");
  const n = Math.min(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    // T3 strictness: i is bounded by both lengths via n.
    const a = as[i]!;
    const b = bs[i]!;
    if (a === b) continue;
    const aDir = i < as.length - 1;
    const bDir = i < bs.length - 1;
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return as.length - bs.length;
}

export function buildRows(
  allOld: string[],
  allNew: string[],
  spec: Spec,
  renames: Map<string, string>,
): Row[] {
  const fileStatus = new Map<string, string>();
  for (const f of spec.files) {
    if (f.status === "Renamed" && f.path.includes(" -> ")) {
      const [o, n] = f.path.split(" -> ");
      // T3 strictness: the includes check above proves both halves exist.
      if (o !== undefined && n !== undefined) {
        fileStatus.set(o, "Renamed");
        fileStatus.set(n, "Renamed");
      }
    } else {
      fileStatus.set(f.path, f.status);
    }
  }
  const oldSet = new Set(allOld);
  const newSet = new Set(allNew);
  const rinv = new Map<string, string>();
  for (const [o, n] of renames) rinv.set(n, o);

  const symsByFile = new Map<string, { old: Symbol[]; cur: Symbol[] }>();
  const byId = (list: Symbol[]) => {
    const m = new Map<string, Symbol>();
    for (const s of list) m.set(s.id, s);
    return m;
  };
  // Split spec symbols into old/new per file. Added/Modified/Unchanged come
  // from the new rev; Deleted from the old rev. Caller passes --all output
  // so Unchanged symbols are present for context rows.
  const newSyms = spec.symbols.filter((s) => s.status !== "Deleted");
  const oldSyms = spec.symbols.filter(
    (s) => s.status === "Deleted" || s.status === "Modified" || s.status === "Unchanged",
  );
  const newById = byId(newSyms);
  const oldById = byId(oldSyms);
  const files = new Set([...newSyms.map((s) => s.file), ...oldSyms.map((s) => s.file)]);
  for (const f of files) {
    const cur = newSyms.filter((s) => s.file === f).sort((a, b) => a.start_line - b.start_line);
    const old = oldSyms.filter((s) => s.file === f).sort((a, b) => a.start_line - b.start_line);
    symsByFile.set(f, { old, cur });
  }
  void newById;
  void oldById;

  const symRows = (opath: string, npath: string): Row[] => {
    const e = symsByFile.get(npath) ?? symsByFile.get(opath);
    if (!e) return [];
    const rows: Row[] = [];
    const moved = opath !== npath;
    const oldMap = new Map(e.old.map((s) => [s.id, s]));
    // Moved files change the id prefix (path::name), so fall back to
    // kind+name matching or every unchanged symbol reads as del+add.
    const oldByName = moved ? new Map(e.old.map((s) => [`${s.kind}::${s.name}`, s])) : null;
    const seen = new Set<string>();
    for (const n of e.cur) {
      const o = oldMap.get(n.id) ?? oldByName?.get(`${n.kind}::${n.name}`);
      seen.add(o?.id ?? n.id);
      if (!o) {
        rows.push({ left: null, right: symCell(n), status: "add" });
      } else if (n.status === "Modified") {
        rows.push({ left: oldSymCell(o), right: symCell(n), status: "mod" });
      } else {
        rows.push({ left: oldSymCell(o), right: symCell(n), status: "same" });
      }
    }
    for (const o of e.old) {
      if (!seen.has(o.id)) rows.push({ left: symCell(o), right: null, status: "del" });
    }
    void opath;
    return rows;
  };

  // Unified pair list sorted once GitHub-style (by new path, deleted by old
  // path interleaved in-tree). Previously two loops: new-tree sorted, then
  // deletions appended last, which broke tree order.
  // Within one directory MOVED entries come first, so one structural move
  // (a deleted dir hoisting everything up a level) reads as a single
  // contiguous block. Modified-in-place, added and deleted files keep plain
  // GitHub order: they are not part of the move and must not fracture it.
  // Across directories this is still plain GitHub order (a DFS tree order).
  const parentDir = (p: string) => {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  };
  const pairs: { opath?: string; npath?: string; key: string; mv: boolean }[] = [];
  for (const npath of allNew) {
    const opath = newSet.has(npath) && oldSet.has(npath) ? npath : rinv.get(npath);
    pairs.push(
      opath ? { opath, npath, key: npath, mv: opath !== npath } : { npath, key: npath, mv: false },
    );
  }
  for (const opath of allOld) {
    if (newSet.has(opath) || renames.has(opath)) continue;
    pairs.push({ opath, key: opath, mv: false });
  }
  pairs.sort((x, y) => {
    if (x.mv !== y.mv && parentDir(x.key) === parentDir(y.key)) return x.mv ? -1 : 1;
    return compareGitHub(x.key, y.key);
  });

  const rows: Row[] = [];
  for (const p of pairs) {
    if (!p.opath || !p.npath) {
      const del = !p.npath;
      const path = (p.npath ?? p.opath)!;
      const st = fileStatus.get(path) ?? (del ? "Deleted" : "Added");
      rows.push(
        del
          ? { left: fileCell(path), right: null, status: toRowStatus(st) }
          : { left: null, right: fileCell(path), status: toRowStatus(st) },
      );
      rows.push(...symRows(path, path).filter((r) => r.status !== "same"));
      continue;
    }
    const { opath, npath } = p;
    const fst = fileStatus.get(npath) ?? fileStatus.get(opath);
    let st: Status;
    if (opath !== npath) st = "moved";
    else if (!fst || fst === "Unchanged") st = "same";
    else st = toRowStatus(fst);
    rows.push({ left: fileCell(opath), right: fileCell(npath), status: st });
    if (st !== "same") rows.push(...symRows(opath, npath));
  }
  return withFolders(rows, allOld, allNew);
}

/** Ancestor dirs of a file path, shallow first. "a/b/c.rs" -> ["a", "a/b"]. */
function ancestors(path: string): string[] {
  const segs = path.split("/");
  const out: string[] = [];
  for (let i = 1; i < segs.length; i++) out.push(segs.slice(0, i).join("/"));
  return out;
}

/** A dir pair (old -> new) is a pure rename when every file under the old
 * dir maps under the new dir with the same relative tail, and vice versa.
 * Covers hoists (DEV/apps -> apps), `git mv old new`, and nested chains
 * (each level qualifies independently). */
function findDirRenames(flat: Row[], allOld: string[], allNew: string[]): Map<string, string> {
  const votes = new Map<string, number>();
  for (const r of flat) {
    if (r.status !== "moved" || !r.left?.isFile || !r.right?.isFile) continue;
    const o = r.left.path;
    const n = r.right.path;
    if (o === n) continue;
    for (const od of ancestors(o)) {
      const tail = o.slice(od.length); // "/rest", same shape both sides
      for (const nd of ancestors(n)) {
        if (n.slice(nd.length) === tail) {
          const k = `${od}\n${nd}`;
          votes.set(k, (votes.get(k) ?? 0) + 1);
        }
      }
    }
  }
  if (!votes.size) return new Map();
  const oldCount = new Map<string, number>();
  const newCount = new Map<string, number>();
  for (const p of allOld) for (const d of ancestors(p)) oldCount.set(d, (oldCount.get(d) ?? 0) + 1);
  for (const p of allNew) for (const d of ancestors(p)) newCount.set(d, (newCount.get(d) ?? 0) + 1);
  const out = new Map<string, string>();
  const claimed = new Set<string>();
  for (const [k, v] of votes) {
    const i = k.indexOf("\n");
    const od = k.slice(0, i);
    const nd = k.slice(i + 1);
    if (v === oldCount.get(od) && v === newCount.get(nd)) {
      // One-to-one: two old dirs never claim the same new dir and back.
      if (!out.has(od) && !claimed.has(nd)) {
        out.set(od, nd);
        claimed.add(nd);
      }
    }
  }
  return out;
}

/** Insert folder rows before their first child so rows read as a file tree. */
function withFolders(flat: Row[], allOld: string[], allNew: string[]): Row[] {
  const oldDirs = new Set<string>();
  const newDirs = new Set<string>();
  for (const p of allOld) for (const d of ancestors(p)) oldDirs.add(d);
  for (const p of allNew) for (const d of ancestors(p)) newDirs.add(d);

  // Directory moves (hoisting, `git mv old new`): every file under an old
  // dir maps under a new dir with the same relative tail. Pair those dirs
  // into single moved folder rows instead of a deleted chain + an added
  // chain with the files floating between them.
  const dirRenames = findDirRenames(flat, allOld, allNew); // old -> new
  const dirRenamesInv = new Map<string, string>();
  for (const [o, n] of dirRenames) dirRenamesInv.set(n, o);

  // Aggregate child file statuses per dir for the folder row status.
  const perDir = new Map<string, Status[]>();
  for (const r of flat) {
    const c = r.left ?? r.right;
    if (!c?.isFile) continue;
    const dirs = new Set<string>();
    if (r.left) for (const d of ancestors(r.left.path)) dirs.add(d);
    if (r.right) for (const d of ancestors(r.right.path)) dirs.add(d);
    for (const d of dirs) {
      const l = perDir.get(d);
      if (l) l.push(r.status);
      else perDir.set(d, [r.status]);
    }
  }
  const dirStatus = (d: string): Status => {
    const ss = perDir.get(d) ?? ["same"];
    if (ss.every((s) => s === "same")) return "same";
    if (ss.every((s) => s === "add")) return "add";
    if (ss.every((s) => s === "del")) return "del";
    // Everything under the dir moved: the dir itself is gone on one side.
    // Left-only (DEV/ after hoisting out) reads as deleted — which is what
    // happened to the directory; the files read as moved, which is what
    // happened to them. Right-only reads as added. Both-sides stays mod.
    if (ss.every((s) => s === "moved")) {
      if (!newDirs.has(d)) return "del";
      if (!oldDirs.has(d)) return "add";
    }
    return "mod";
  };
  const folderRow = (d: string): Row => ({
    left: oldDirs.has(d) ? dirCell(d) : null,
    right: newDirs.has(d) ? dirCell(d) : null,
    status: dirStatus(d),
  });
  const movedFolderRow = (o: string, n: string): Row => ({
    left: dirCell(o),
    right: dirCell(n),
    status: "moved",
  });

  const out: Row[] = [];
  const emitted = new Set<string>();
  const need = (p: string) => {
    for (const d of ancestors(p)) {
      if (emitted.has(d)) continue;
      // Either side of a renamed dir emits the single paired row.
      const o = dirRenamesInv.get(d) ?? d;
      const n = dirRenames.get(o);
      if (n === undefined) {
        emitted.add(d);
        out.push(folderRow(d));
      } else if (emitted.has(o) || emitted.has(n)) {
        emitted.add(d);
      } else {
        emitted.add(o);
        emitted.add(n);
        out.push(movedFolderRow(o, n));
      }
    }
  };
  for (const r of flat) {
    const c = r.left ?? r.right;
    if (c?.isFile) {
      if (r.left) need(r.left.path);
      if (r.right) need(r.right.path);
    }
    out.push(r);
  }
  return out;
}

export interface ViewOpts {
  depth: number; // max visible cell depth (file-tree nesting threshold)
  hideKinds: Set<string>; // symbol kinds switched off
  query: string;
  showFiles?: boolean; // false = hide file rows (default true)
  showDotfiles?: boolean; // false = hide dotfiles (default true)
}

/** A path is a dotfile if any segment starts with ".". */
function isDot(path: string): boolean {
  return path.split("/").some((s) => s.startsWith(".") && s.length > 1);
}

export function filterRows(rows: Row[], opts: ViewOpts): Row[] {
  const q = opts.query.trim().toLowerCase();
  const showFiles = opts.showFiles ?? true;
  const showDotfiles = opts.showDotfiles ?? true;
  const matchQ = (cell: Cell) =>
    !q || cell.label.toLowerCase().includes(q) || cell.path.toLowerCase().includes(q);
  // Pass 1: files + symbols.
  const keep = new Set<Row>();
  const keptDirs = new Set<string>();
  for (const r of rows) {
    const cell = r.right ?? r.left;
    if (!cell) continue;
    if (cell.isFolder) continue;
    if (cell.depth > opts.depth) continue;
    if (!showDotfiles && isDot(cell.path)) continue;
    if (cell.isFile) {
      if (!showFiles) continue;
    } else if (opts.hideKinds.has(cell.kind ?? "")) continue;
    if (!matchQ(cell)) continue;
    keep.add(r);
    const paths: string[] = [];
    if (r.left) paths.push(r.left.path);
    if (r.right) paths.push(r.right.path);
    for (const p of paths) for (const d of ancestors(p)) keptDirs.add(d);
  }
  // Pass 2: folders stay if shallow enough and (match query or ancestor of a kept row).
  return rows.filter((r) => {
    const cell = r.right ?? r.left;
    if (!cell) return false;
    if (!cell.isFolder) return keep.has(r);
    if (cell.depth > opts.depth) return false;
    if (!showDotfiles && isDot(cell.path)) return false;
    if (matchQ(cell)) return true;
    return keptDirs.has(cell.path);
  });
}

export const STATUS_META: Record<Status, { bg: string; fg: string; mark: string }> = {
  // Grayscale ladder: zinc-950 page -> zinc-900 stage -> zinc-800 rows.
  // Change hues stay dark so text stays readable on zinc-800.
  same: { bg: "#27272a", fg: "#a1a1aa", mark: " " },
  del: { bg: "#3c1f22", fg: "#ffa198", mark: "D" },
  add: { bg: "#1a3a27", fg: "#7ee787", mark: "A" },
  mod: { bg: "#3a2f12", fg: "#e3b341", mark: "M" },
  moved: { bg: "#1a2f45", fg: "#79c0ff", mark: "M" },
};

// Stable identity for view state (collapse sets, depth anchors).
export function rowKey(r: Row): string {
  const c = (x: Row["left"]) =>
    x ? `${x.isCode ? "C" : x.isFile ? "F" : "S"}:${x.path}:${x.label}` : "-";
  return `${r.status}|${c(r.left)}|${c(r.right)}`;
}

// --- Manual tree folding: any folder or file with children can collapse ---
// Expandable symbols count too, before their code loads (no kids yet).
// Children are the contiguous run after a parent: deeper rows (folders), or
// deeper same-path rows (a file's symbols). Collapsed children leave the
// visible list, so camera, canvas, and minimap stay 1:1 with no translation.
// A symbol the UI can unfold inline (mirrors isSymbolRow in App.tsx):
// has a kind, isn't a file/folder/code slot, and carries a change.
function isExpandableSymbol(r: Row): boolean {
  if (r.status === "same") return false;
  const c = r.right ?? r.left;
  return !!c && !c.isFile && !c.isFolder && !c.isCode && !!c.kind;
}

// A file the UI can unfold inline when it has no symbol children:
// changed, not a folder/code slot. Same twisty affordance as symbols.
export function isExpandableFile(r: Row): boolean {
  if (r.status === "same") return false;
  const c = r.right ?? r.left;
  return !!c && !!c.isFile && !c.isCode;
}

function treeLinks(rows: Row[]): { parent: number[]; hasKids: boolean[]; parentable: boolean[] } {
  const n = rows.length;
  const parent = new Array<number>(n).fill(-1);
  const hasKids = new Array<boolean>(n).fill(false);
  const parentable = new Array<boolean>(n).fill(false);
  const stack: { idx: number; depth: number; childPath: string | null }[] = [];
  rows.forEach((r, i) => {
    const cell = r.right ?? r.left;
    if (!cell) return;
    parentable[i] = cell.isFile || !!cell.isFolder;
    while (stack.length > 0) {
      // T3 strictness: length check above proves the top exists.
      const t = stack[stack.length - 1]!;
      if (cell.depth > t.depth && (t.childPath === null || cell.path === t.childPath)) break;
      stack.pop();
    }
    if (stack.length > 0) {
      const p = stack[stack.length - 1]!;
      parent[i] = p.idx;
      hasKids[p.idx] = true;
    }
    stack.push({
      idx: i,
      depth: cell.depth,
      childPath: cell.isFile && !cell.isFolder ? cell.path : null,
    });
  });
  // Symbols with unfolded code children fold like files: a symbol is only
  // ever followed by a deeper row when its code lines were injected, so this
  // changes nothing for plain file/symbol rows.
  rows.forEach((r, i) => {
    if (!parentable[i] && hasKids[i]) {
      const cell = r.right ?? r.left;
      if (cell?.kind) parentable[i] = true;
    }
  });
  return { parent, hasKids, parentable };
}

export function collapseRows(
  rows: Row[],
  collapsed: Set<string>,
): { visible: Row[]; collapsible: Set<Row> } {
  const { parent, hasKids, parentable } = treeLinks(rows);
  const visible: Row[] = [];
  const collapsible = new Set<Row>();
  const shut = rows.map((r) => collapsed.has(rowKey(r)));
  const hidden = new Array<boolean>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    // T3 strictness: i is bounded by rows.length; parent links default to -1.
    const p = parent[i] ?? -1;
    hidden[i] = p >= 0 && ((shut[p] ?? false) || (hidden[p] ?? false));
    const row = rows[i]!;
    if (
      (parentable[i] && hasKids[i]) ||
      isExpandableSymbol(row) ||
      (isExpandableFile(row) && !hasKids[i])
    )
      collapsible.add(row);
    if (!hidden[i]) visible.push(row);
  }
  return { visible, collapsible };
}

// Default folds: every collapsible node whose subtree holds no change starts
// shut; ancestors of changes (and changed files themselves) stay open, so a
// fresh diff shows exactly the touched parts of the tree.
export function defaultCollapsed(rows: Row[]): Set<string> {
  const { parent, hasKids, parentable } = treeLinks(rows);
  const touched = rows.map((r) => r.status !== "same");
  for (let i = rows.length - 1; i >= 0; i--) {
    // T3 strictness: i is bounded by rows.length; parent links default to -1.
    if ((touched[i] ?? false) && (parent[i] ?? -1) >= 0) touched[parent[i]!] = true;
  }
  const out = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (parentable[i] && hasKids[i] && !touched[i]) out.add(rowKey(row));
    // Unexpanded symbols/files have no kids yet: start shut so the twisty
    // reads shut (▸), not open. Loaded ones have kids + stay open (touched).
    else if ((isExpandableSymbol(row) || isExpandableFile(row)) && !hasKids[i])
      out.add(rowKey(row));
  }
  return out;
}

// --- Inline symbol code: unfolded hunks live in the tree as child rows ---
// A symbol row with an entry here reserves slots for its hunk's visible
// lines (depth +1 nests them under the symbol via treeLinks, so folding,
// sticky parents, the minimap, and zoom treat them as ordinary tree rows).
// Long unchanged runs collapse to one gap row per hidden range (see
// hunkBlocks in lib/code.ts): click it to expand. The slots carry only
// status tint — pierre-rendered hunk windows paint the actual code over the
// visible ranges. Keyed by the symbol's rowKey; built client-side by
// alignCode (lib/code.ts).
import { safeHunkBlocks, HUNK_CONTEXT, type ExpandedHunk } from "./code";

export function injectCodeRows(rows: Row[], code: Map<string, ExpandedHunk>): Row[] {
  if (code.size === 0) return rows;
  const out: Row[] = [];
  for (const r of rows) {
    out.push(r);
    const hunk = code.get(rowKey(r));
    const lines = hunk?.lines;
    if (!lines || lines.length === 0) continue;
    const sym = r.right ?? r.left;
    if (!sym || sym.isFolder || sym.isCode) continue;
    if (!sym.kind && !sym.isFile) continue; // symbols + files only
    const depth = sym.depth + 1;
    const codeCell = (text: string | null) =>
      text != null ? { label: "", path: sym.path, depth, isFile: false, isCode: true } : null;
    for (const b of safeHunkBlocks(lines, HUNK_CONTEXT, hunk.expanded)) {
      if (b.kind === "gap") {
        const count = b.end - b.start;
        const cell = {
          label: `gap:${b.gapIdx}`,
          path: sym.path,
          depth,
          isFile: false,
          isCode: true,
          isGap: true,
          gapCount: count,
          gapIdx: b.gapIdx,
        };
        out.push({ left: { ...cell }, right: { ...cell }, status: "same" });
        continue;
      }
      for (let i = b.start; i < b.end; i++) {
        // T3 strictness: i is bounded by the block inside lines.
        const ln = lines[i]!;
        out.push({
          left: codeCell(ln.oldText),
          right: codeCell(ln.newText),
          status: ln.status,
        });
      }
    }
  }
  return out;
}

// Sticky parents (VS Code sticky-scroll): parent chain of one row.
export function parentLinks(rows: Row[]): number[] {
  return treeLinks(rows).parent;
}

// Ancestor indices of rows[topIdx], root first. Empty when topIdx is a root
// or out of range. Callers memoize parentLinks per visible list; this walk
// itself is O(depth).
export function stickyStack(parents: number[], topIdx: number): number[] {
  if (topIdx < 0 || topIdx >= parents.length) return [];
  const out: number[] = [];
  // T3 strictness: topIdx is range-checked above; missing links read as -1.
  let p = parents[topIdx] ?? -1;
  while (p >= 0) {
    out.push(p);
    p = parents[p] ?? -1;
  }
  return out.reverse();
}
