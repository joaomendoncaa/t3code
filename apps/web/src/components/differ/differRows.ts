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
  // allOld/allNew hold the full file list at each rev when callers plumb it;
  // otherwise union them with entry paths so diff-only input stays unchanged.
  const allOld = [...new Set([...(full?.allOld ?? []), ...oldFromEntries])];
  const allNew = [...new Set([...(full?.allNew ?? []), ...newFromEntries])];
  return buildRows(allOld, allNew, { files, symbols: [] }, renames);
}
