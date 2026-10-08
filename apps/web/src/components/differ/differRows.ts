// File entries -> differ tree rows. Pure glue between T3's file diffs and
// the vendored differ row builder: maps change types onto differ statuses,
// pairs old/new paths (renames included), and builds the folder tree. No
// symbols yet — the tree is file-level until the symbol service lands.
import { buildRows, type Row } from "./rows";
import type { DifferFileEntry } from "./DifferTreeView";

export function differRowsForEntries(entries: DifferFileEntry[]): Row[] {
  const allOld: string[] = [];
  const allNew: string[] = [];
  const renames = new Map<string, string>();
  const files = entries.map((entry) => {
    switch (entry.status) {
      case "Added":
        allNew.push(entry.path);
        return { path: entry.path, status: "Added" };
      case "Deleted":
        allOld.push(entry.prevPath);
        return { path: entry.prevPath, status: "Deleted" };
      case "Renamed":
        allOld.push(entry.prevPath);
        allNew.push(entry.path);
        renames.set(entry.prevPath, entry.path);
        return { path: `${entry.prevPath} -> ${entry.path}`, status: "Renamed" };
      case "Modified":
      default:
        allOld.push(entry.path);
        allNew.push(entry.path);
        return { path: entry.path, status: "Modified" };
    }
  });
  return buildRows(allOld, allNew, { files, symbols: [] }, renames);
}
