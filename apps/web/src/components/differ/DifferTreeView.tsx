// Differ tree view: the differ project's canvas tree rendered inside T3's
// diff surface (same `kind: "diff"` panel, no new surface kind).
//
// T3 adaptation, all in this file:
// - No GitHub OAuth: differ's AuthButton/useMe + /api/auth/* are dropped.
//   T3 already knows the user; nothing here needs a login.
// - No repo/rev pickers: differ's onboarding form + RevPicker + /api/rev,
//   /api/commits, /api/validate are dropped. The comparison scope comes from
//   T3's diff selection (branch/unstaged/turn) via props.
// - No differ server: /api/diff, /api/file, /api/diff-progress are dropped.
//   Rows are built from T3's own diff data (file-level today). Symbol rows,
//   hunk overlays, and file contents stay a follow-up until a
//   tree-sitter symbol service exists server-side (differ's Rust binary).
// - Theme: differ's useTheme (own .dark class + localStorage) is dropped.
//   `dark` comes from T3's useTheme, so the canvas follows the app palette.
//
// Data contract: entries carry the new path, the previous path (renames),
// and a differ-style status. buildRows pairs them into the tree; folder rows
// and GitHub-style ordering come along for free.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import DiffCanvas, { hitRow } from "./DiffCanvas";
import { differRowsForEntries } from "./differRows";
import Minimap from "./Minimap";
import { collapseRows, defaultCollapsed, filterRows, rowKey, type Row } from "./rows";
import { DiffStatLabel } from "../chat/DiffStatLabel";

export type DifferFileStatus = "Added" | "Modified" | "Deleted" | "Renamed";

export interface DifferFileEntry {
  /** New path (or only path for add/modify/delete). */
  path: string;
  /** Old path; differs from path only for renames. */
  prevPath: string;
  status: DifferFileStatus;
}

interface DifferTreeViewProps {
  entries: DifferFileEntry[];
  /** e.g. "Changes", "Uncommitted", "Turn 3". From T3's diff selection. */
  scopeLabel: string;
  baseLabel: string | null;
  headLabel: string | null;
  onOpenFile: (path: string) => void;
}

const ROW_H = 28;

function isFileRow(row: Row): boolean {
  const cell = row.right ?? row.left;
  return cell !== null && cell !== undefined && cell.isFile && !cell.isFolder;
}

export default function DifferTreeView(props: DifferTreeViewProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";

  const rows = useMemo(() => differRowsForEntries(props.entries), [props.entries]);

  const visible = useMemo(
    () =>
      filterRows(rows, {
        depth: Number.MAX_SAFE_INTEGER,
        hideKinds: new Set<string>(),
        query: "",
        showFiles: true,
        showDotfiles: true,
      }),
    [rows],
  );

  const [collapsed, setCollapsed] = useState<Set<string>>(() => defaultCollapsed(visible));
  const [y, setY] = useState(0);
  // New file set (scope switch, fresh changes): refold to the touched paths
  // and reframe the top, like a fresh diff arrival.
  useEffect(() => {
    setCollapsed(defaultCollapsed(visible));
    setY(0);
  }, [visible]);

  const tree = useMemo(() => collapseRows(visible, collapsed), [visible, collapsed]);
  const list = tree.visible;

  const totals = useMemo(() => {
    // Full-scope totals: collapsing a folder must not shrink the counts.
    let add = 0;
    let del = 0;
    for (const row of visible) {
      if (row.status === "add") add += 1;
      else if (row.status === "del") del += 1;
      else if (row.status === "mod") {
        add += 1;
        del += 1;
      }
    }
    return { add, del };
  }, [visible]);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stageH, setStageH] = useState(0);
  const [stageW, setStageW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const ro = new ResizeObserver(() => {
      setStageH(stage.clientHeight);
      setStageW(stage.clientWidth);
    });
    ro.observe(stage);
    return () => ro.disconnect();
  }, []);

  const clampY = useCallback(
    (next: number) => {
      const total = list.length * ROW_H;
      if (total <= stageH || stageH <= 0) return 0;
      return Math.min(0, Math.max(stageH - total, next));
    },
    [list.length, stageH],
  );

  const onWheel = useCallback(
    (event: React.WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      setY((current) => clampY(current - event.deltaY));
    },
    [clampY],
  );

  const jumpTo = useCallback(
    (idx: number) => {
      if (!stageH) return;
      setY(clampY(stageH / 2 - (idx + 0.5) * ROW_H));
    },
    [clampY, stageH],
  );

  const onClick = useCallback(
    (event: React.MouseEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const idx = hitRow(list, { x: 0, y, k: 1 }, ROW_H, mx, my, stageW);
      if (idx < 0) return;
      const row = list[idx];
      if (!row) return;
      const key = rowKey(row);
      if (tree.collapsible.has(row)) {
        setCollapsed((current) => {
          const next = new Set(current);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        return;
      }
      if (isFileRow(row)) {
        const cell = row.right ?? row.left;
        if (cell) props.onOpenFile(cell.path);
      }
    },
    [list, y, stageW, tree.collapsible, props],
  );

  const onMouseMove = useCallback(
    (event: React.MouseEvent) => {
      const stage = stageRef.current;
      if (!stage) return;
      const rect = stage.getBoundingClientRect();
      const idx = hitRow(
        list,
        { x: 0, y, k: 1 },
        ROW_H,
        event.clientX - rect.left,
        event.clientY - rect.top,
        stageW,
      );
      setHover(idx >= 0 ? idx : null);
    },
    [list, y, stageW],
  );

  const revision = [props.baseLabel, props.headLabel].filter(Boolean).join("…");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 px-3 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{props.scopeLabel}</span>
        {revision ? <span className="truncate font-mono">{revision}</span> : null}
        <span className="ml-auto shrink-0">
          <DiffStatLabel additions={totals.add} deletions={totals.del} layout="inline" />
        </span>
      </div>
      <div className="flex min-h-0 flex-1">
        <div
          ref={stageRef}
          className="relative min-h-0 min-w-0 flex-1 cursor-pointer overflow-hidden"
          onWheel={onWheel}
          onClick={onClick}
          onMouseMove={onMouseMove}
          onMouseLeave={() => setHover(null)}
        >
          {list.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted-foreground">No changes in scope.</p>
          ) : (
            <DiffCanvas
              rows={list}
              cam={{ x: 0, y, k: 1 }}
              width={Math.max(stageW, 1)}
              rowH={ROW_H}
              collapsed={collapsed}
              collapsible={tree.collapsible}
              hover={hover}
              dark={dark}
            />
          )}
        </div>
        {list.length > 0 ? (
          <div className="w-20 shrink-0 border-l border-border/60">
            <Minimap
              full={list}
              cam={{ x: 0, y, k: 1 }}
              rowH={ROW_H}
              viewH={stageH}
              onJump={jumpTo}
              dark={dark}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
