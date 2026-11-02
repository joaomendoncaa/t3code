// Differ tree view: the differ project's canvas tree rendered inside T3's
// existing diff panel. No GitHub auth, repo pickers or differ server: rows
// come from T3's diff props, and `dark` comes from T3's theme.
import { useEffect, useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { useClientSettings } from "../../hooks/useSettings";
import {
  appearanceFontStack,
  clampCodeFontSize,
  DEFAULT_CODE_FONT_STACK,
} from "../../appearanceFonts";
import { DEFAULT_CODE_FONT_SIZE } from "@t3tools/contracts";
import { observeResize } from "../../lib/observeResize";
import DiffCanvas, { hitRow } from "./DiffCanvas";
import { differRowsForEntries } from "./differRows";
import Minimap from "./Minimap";
import { collapseRows, defaultCollapsed, filterRows, rowKey, type Row } from "./rows";
import { DiffStatLabel } from "../chat/DiffStatLabel";

export type DifferFileStatus = "Added" | "Modified" | "Deleted" | "Renamed" | "Unchanged";

export interface DifferFileEntry {
  /** New path (or only path for add/modify/delete). */
  path: string;
  /** Old path; differs from path only for renames. */
  prevPath: string;
  status: DifferFileStatus;
}

interface DifferTreeViewProps {
  entries: DifferFileEntry[];
  /** Full file lists at each rev; when present, untouched paths render as
   * collapsed "same" rows like differ. Absent = diff nodes only. */
  allOld?: string[];
  allNew?: string[];
  /** e.g. "Changes", "Uncommitted", "Turn 3". From T3's diff selection. */
  scopeLabel: string;
  baseLabel: string | null;
  headLabel: string | null;
  onOpenFile: (path: string) => void;
}

function isFileRow(row: Row): boolean {
  const cell = row.right ?? row.left;
  return cell !== null && cell !== undefined && cell.isFile && !cell.isFolder;
}

export default function DifferTreeView(props: DifferTreeViewProps) {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === "dark";
  // Canvas text can't read CSS vars, so resolve the code font here and hand
  // concrete values down. Row height scales from 28px at the 13px default.
  const fontSizeCode = useClientSettings((settings) => settings.fontSizeCode);
  const fontFamilyCode = useClientSettings((settings) => settings.fontFamilyCode);
  const codeSize = clampCodeFontSize(fontSizeCode);
  const codeFamily = appearanceFontStack(fontFamilyCode, DEFAULT_CODE_FONT_STACK);
  const treeFont = `${codeSize}px ${codeFamily}`;
  const treeMarkFont = `bold ${codeSize}px ${codeFamily}`;
  const rowH = Math.max(20, Math.round((28 * codeSize) / DEFAULT_CODE_FONT_SIZE));

  const rows = differRowsForEntries(props.entries, {
    allOld: props.allOld,
    allNew: props.allNew,
  });

  const visible = filterRows(rows, {
    depth: Number.MAX_SAFE_INTEGER,
    hideKinds: new Set<string>(),
    query: "",
    showFiles: true,
    showDotfiles: true,
  });

  const scopeKey = visible.map(rowKey).join("\n");
  const [lastScopeKey, setLastScopeKey] = useState(scopeKey);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => defaultCollapsed(visible));
  const [y, setY] = useState(0);
  // A new file set refolds to the touched paths and reframes the top, like a
  // fresh diff arrival. Keyed by row identity so content updates keep the fold.
  if (lastScopeKey !== scopeKey) {
    setLastScopeKey(scopeKey);
    setCollapsed(defaultCollapsed(visible));
    setY(0);
  }

  const tree = collapseRows(visible, collapsed);
  const list = tree.visible;

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
  const totals = { add, del };

  const stageRef = useRef<HTMLDivElement>(null);
  const [stageH, setStageH] = useState(0);
  const [stageW, setStageW] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tracks the stage element's size for canvas layout
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    return observeResize(stage, () => {
      setStageH(stage.clientHeight);
      setStageW(stage.clientWidth);
    });
  }, []);

  const clampY = (next: number) => {
    const total = list.length * rowH;
    if (total <= stageH || stageH <= 0) return 0;
    return Math.min(0, Math.max(stageH - total, next));
  };

  const onWheel = (event: React.WheelEvent) => {
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    setY((current) => clampY(current - event.deltaY));
  };

  const jumpTo = (idx: number) => {
    if (!stageH) return;
    setY(clampY(stageH / 2 - (idx + 0.5) * rowH));
  };

  const onClick = (event: React.MouseEvent) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const mx = event.clientX - rect.left;
    const my = event.clientY - rect.top;
    const idx = hitRow(list, { x: 0, y, k: 1 }, rowH, mx, my, stageW);
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
  };

  const onMouseMove = (event: React.MouseEvent) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const idx = hitRow(
      list,
      { x: 0, y, k: 1 },
      rowH,
      event.clientX - rect.left,
      event.clientY - rect.top,
      stageW,
    );
    setHover(idx >= 0 ? idx : null);
  };

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
              rowH={rowH}
              font={treeFont}
              markFont={treeMarkFont}
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
              rowH={rowH}
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
