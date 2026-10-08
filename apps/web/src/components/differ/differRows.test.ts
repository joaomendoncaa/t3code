import { describe, expect, it } from "vite-plus/test";

import { differRowsForEntries } from "./differRows";
import type { Row } from "./rows";

function fileRows() {
  return differRowsForEntries([
    { path: "src/new.ts", prevPath: "src/new.ts", status: "Added" },
    { path: "src/gone.ts", prevPath: "src/gone.ts", status: "Deleted" },
    { path: "src/app.ts", prevPath: "src/app.ts", status: "Modified" },
    { path: "src/new-name.ts", prevPath: "src/old-name.ts", status: "Renamed" },
  ]);
}

function rowForPath(rows: Row[], path: string): Row | undefined {
  return rows.find(
    (row) => (row.right ?? row.left)?.path === path && (row.right ?? row.left)?.isFile,
  );
}

describe("differRowsForEntries", () => {
  it("maps add/del/mod/rename onto tree rows with folder parents", () => {
    const rows = fileRows();

    expect(rowForPath(rows, "src/new.ts")?.status).toBe("add");
    expect(rowForPath(rows, "src/gone.ts")?.status).toBe("del");
    expect(rowForPath(rows, "src/app.ts")?.status).toBe("mod");

    const moved = rows.find((row) => row.status === "moved");
    expect(moved?.left?.path).toBe("src/old-name.ts");
    expect(moved?.right?.path).toBe("src/new-name.ts");

    // Folder row parents the files.
    const folder = rows.find((row) => row.right?.isFolder && row.right.path === "src");
    expect(folder).toBeDefined();
  });

  it("returns an empty tree for no entries", () => {
    expect(differRowsForEntries([])).toEqual([]);
  });
});
