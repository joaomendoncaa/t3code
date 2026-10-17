// File entries -> differ tree rows. Pure glue between T3's file diffs and
// the vendored differ row builder: maps change types onto differ statuses,
// pairs old/new paths (renames included), and builds the folder tree. No
// symbols yet — the tree is file-level until the symbol service lands.
import { buildRows, type Row } from "./rows";
import type { DifferFileEntry } from "./DifferTreeView";

export function differRowsForEntries(
  entries: DifferFileEntry[],
  full?: { allOld?: string[] | undefined; allNew?: string[] | undefined },
): Row[] {
  const oldFromEntries: string[] = [];
  const newFromEntries: string[] = [];
  const renames = new Map<string, string>();
  const files = entries.map((entry) => {
    switch (entry.status) {
      case "Added":
        newFromEntries.push(entry.path);
        return { path: entry.path, status: "Added" };
      case "Deleted":
        oldFromEntries.push(entry.prevPath);
        return { path: entry.prevPath, status: "Deleted" };
      case "Renamed":
        oldFromEntries.push(entry.prevPath);
        newFromEntries.push(entry.path);
        renames.set(entry.prevPath, entry.path);
        return { path: `${entry.prevPath} -> ${entry.path}`, status: "Renamed" };
      case "Unchanged":
        oldFromEntries.push(entry.path);
        newFromEntries.push(entry.path);
        return { path: entry.path, status: "Unchanged" };
      case "Modified":
      default:
        oldFromEntries.push(entry.path);
        newFromEntries.push(entry.path);
        return { path: entry.path, status: "Modified" };
    }
  });
  // Differ renders the entire tree: allOld/allNew are the full file lists
  // at each rev, and unchanged paths become "same" rows (collapsed by
  // defaultCollapsed). Until callers plumb a full listing, this unions the
  // entry-derived paths with the optional full lists, so diff-only input
  // keeps today's behavior unchanged.
  const allOld = [...new Set([...(full?.allOld ?? []), ...oldFromEntries])];
  const allNew = [...new Set([...(full?.allNew ?? []), ...newFromEntries])];
  return buildRows(allOld, allNew, { files, symbols: [] }, renames);
}
