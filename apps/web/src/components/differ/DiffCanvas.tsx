// Canvas diff renderer: one viewport-sized framebuffer, constant memory no
// matter how many rows. Only the visible window is drawn; everything else is
// math, never DOM.
// Canvas diff tree renderer, vendored from the differ project
// (differ/src/components/DiffCanvas.tsx) onto the differ-tree-view branch.
// Only the import paths below were adjusted; rendering logic is verbatim so
// future differ improvements merge cleanly. T3 adaptation (theme, repo
// context, auth) lives in DifferTreeView.tsx, not here.
import { useEffect, useReducer, useRef } from "react";
import { STATUS_META, rowKey, type Cell, type Row, type Status } from "./rows";
import { KINDS, iconImg, onIconLoad, themeIcon } from "./icons";

export interface Cam {
  x: number;
  y: number;
  k: number;
}

const FONT = "13px ui-monospace, SFMono-Regular, Menlo, monospace";
const MARK_FONT = "bold 13px ui-monospace, SFMono-Regular, Menlo, monospace";
// Braille spinner for rows loading their hunk (fetch or staged paint).
// 8-dot frames fill the full cell height, so the ink stays vertically
// centered on the label; 6-dot frames leave the bottom row empty and ride high.
const SPIN = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
// Light palette (GitHub Primer-ish pastels); dark reuses STATUS_META.
const LIGHT_BG: Record<Status, string> = {
  same: "#f4f4f5",
  del: "#ffe4e6",
  add: "#dcfce7",
  mod: "#fef9c3",
  moved: "#e0f2fe",
};
export const LIGHT_FG: Record<Status, string> = {
  same: "#52525b",
  del: "#b91c1c",
  add: "#15803d",
  mod: "#a16207",
  moved: "#0284c7",
};
const DARK_CHROME = {
  hairline: "#3f3f46",
  hoverBg: "rgba(255,255,255,0.08)",
  guide: "rgba(255,255,255,0.08)",
  body: "#111113",
};
const LIGHT_CHROME = {
  hairline: "#e4e4e7",
  hoverBg: "rgba(0,0,0,0.06)",
  guide: "rgba(0,0,0,0.10)",
  body: "#fafafa",
};
const INDENT = 16;
const ICON = 16;

/** Row index under a stage-relative point, or -1. Rejects clicks outside
 *  the diff body horizontally, so empty stage space never hits a row. */
export function hitRow(
  rows: Row[],
  cam: Cam,
  rowH: number,
  mx: number,
  my: number,
  width: number,
): number {
  // Backgrounds are full-bleed: any x inside the stage hits.
  void mx;
  void width;
  const idx = Math.floor((my - cam.y) / cam.k / rowH);
  return idx >= 0 && idx < rows.length ? idx : -1;
}

// A moved pair shows two different paths on one row.
export function isMovedPair(r: Row): boolean {
  return r.status === "moved" && !!r.left && !!r.right && r.left.path !== r.right.path;
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return "";
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= maxW) lo = mid + 1;
    else hi = mid;
  }
  return text.slice(0, Math.max(0, lo - 1)) + "…";
}

function cellIcon(cell: Cell, open: boolean): HTMLImageElement | null {
  // T3 strictness note: KINDS is empty in this port (see ./icons), so the
  // first branch always misses — kept for when the symbol service ships art.
  if (cell.kind) {
    const art = KINDS[cell.kind];
    return art ? iconImg(art.src) : null;
  }
  if (!cell.icon) return null;
  return iconImg(themeIcon(cell.isFolder && open ? `${cell.icon}-open` : cell.icon));
}

// Drawn label text: basenames, so the tree reads as names, not paths.
function cellLabel(cell: Cell): string {
  if (cell.kind) return cell.label.slice(cell.label.indexOf(" ") + 1);
  return cell.label.replace(/\/$/, "");
}

// [twisty] [mark] [indent guides] [icon] label. Symbols drop the "fn "
// prefix: the icon carries the kind. Code slots (isCode) only take the
// status tint: the hunk overlay paints the code over the slot range —
// unless bare, when they stay transparent (pierre hasn't painted yet;
// tint would flash as empty rows).
function drawCell(
  ctx: CanvasRenderingContext2D,
  cell: Cell | null,
  next: Cell | null,
  status: Status,
  x0: number,
  w: number,
  y: number,
  rowH: number,
  twisty: "open" | "shut" | null,
  dark: boolean,
  dim = false,
  bare = false,
  bgX0?: number,
  bgW?: number,
  spin: string = SPIN[0] ?? "",
) {
  const chrome = dark ? DARK_CHROME : LIGHT_CHROME;
  // Background stretches full-bleed (stage width); text stays at x0/w so
  // the tree reads centered. Defaults keep old callers working.
  const bx0 = bgX0 ?? x0;
  const bw = bgW ?? w;
  if (bare) {
    // Unpainted slots stay transparent so the card shows through (same as
    // the header): no empty tinted flash before pierre paints.
    return;
  }
  // One-sided rows (add/del): the empty half stays transparent — same
  // background as a normal node, with no guides or hairline — so only the
  // present side carries the status tint.
  if (!cell) return;
  const m = STATUS_META[status];
  // Unmodified rows stay transparent: the card (same as the header) shows
  // through instead of a second gray. Only changed rows carry a tint.
  const changed = status !== "same";
  const fg = dark ? m.fg : LIGHT_FG[status];
  if (changed) {
    const bg = dark ? m.bg : LIGHT_BG[status];
    ctx.fillStyle = bg;
    ctx.fillRect(bx0, y, bw, rowH);
  }
  const cy = y + rowH / 2;
  // Collapsed unchanged run: a centered expand affordance across the full
  // row. Drawn twice (once per half) with identical pixels, so either call
  // paints it alone.
  if (cell.isCode) {
    if (cell.isGap) {
      const bx0 = bgX0 ?? x0;
      const bw = bgW ?? w;
      ctx.fillStyle = dark ? "#71717a" : "#a1a1aa";
      ctx.font = FONT;
      ctx.textAlign = "center";
      ctx.fillText(`${cell.gapCount ?? "?"} unmodified lines`, bx0 + bw / 2, cy);
      ctx.textAlign = "left";
    }
    return;
  }
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.font = MARK_FONT;
  ctx.fillText(m.mark, x0 + 8, cy);
  const tx = x0 + 24;
  ctx.fillStyle = chrome.guide;
  for (let d = 0; d < cell.depth; d++) ctx.fillRect(tx + d * INDENT + 7, y, 1, rowH);
  const bx = tx + cell.depth * INDENT;
  if (twisty) {
    ctx.fillStyle = fg;
    ctx.font = MARK_FONT;
    ctx.textAlign = "center";
    ctx.fillText(twisty === "open" ? "▾" : "▸", bx + 7, cy);
    ctx.textAlign = "left";
  }
  const ix = bx + 14;
  const open = !!cell.isFolder && !!next && next.depth > cell.depth;
  const img = cellIcon(cell, open);
  if (img) ctx.drawImage(img, ix, cy - ICON / 2, ICON, ICON);
  const lx = ix + ICON + 6;
  const label = cellLabel(cell);
  ctx.fillStyle = fg;
  ctx.globalAlpha = dim ? 0.55 : 1;
  ctx.font = cell.isFolder ? MARK_FONT : FONT;
  ctx.fillText(ellipsize(ctx, dim ? `${label}  ${spin}` : label, x0 + w - lx - 8), lx, cy);
  ctx.globalAlpha = 1;
}

export default function DiffCanvas({
  rows,
  cam,
  width,
  rowH,
  collapsed,
  collapsible,
  hover,
  sticky = [],
  dark = true,
  hl = null,
  loading = null,
  bare = null,
}: {
  rows: Row[];
  cam: Cam;
  width: number;
  rowH: number;
  collapsed: Set<string>;
  collapsible: Set<Row>;
  hover?: number | null;
  sticky?: number[];
  dark?: boolean;
  hl?: Set<string> | null;
  loading?: Set<string> | null;
  // Code-slot indices to draw untinted (pierre overlay not painted yet).
  bare?: Set<number> | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [iconTick, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onIconLoad(bump), []);
  // Advance the braille spinner only while some row is loading it.
  const [spinTick, bumpSpin] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if ((loading?.size ?? 0) === 0) return;
    const t = window.setInterval(bumpSpin, 80);
    return () => window.clearInterval(t);
  }, [loading]);

  useEffect(() => {
    const cv = ref.current;
    const parent = cv?.parentElement;
    if (!cv || !parent) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (!w || !h) return;
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (cv.width !== bw || cv.height !== bh) {
        cv.width = bw;
        cv.height = bh;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const chrome = dark ? DARK_CHROME : LIGHT_CHROME;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.setTransform(dpr * cam.k, 0, 0, dpr * cam.k, dpr * cam.x, dpr * cam.y);
      // Full-bleed backgrounds: world span of the visible stage. When the
      // tree (width) is narrower it stays centered via cam.x and the bg
      // extends into the gutters; when zoomed/panned past overflow this
      // collapses back to the visible slice of the content. No base fill:
      // the card (same as the header) shows through, so header and canvas
      // are one surface and `same` rows need no paint.
      const worldL = -cam.x / cam.k;
      const worldR = (w - cam.x) / cam.k;
      const y0 = (0 - cam.y) / cam.k;
      const y1 = (h - cam.y) / cam.k;
      const s = Math.max(0, Math.floor(y0 / rowH));
      const e = Math.min(rows.length, Math.ceil(y1 / rowH));
      const mid = width / 2;
      ctx.textBaseline = "middle";
      // Full paths on moved pairs ("DEV/apps/ -> apps/"), basenames elsewhere.
      const hlStyle = () => {
        ctx.strokeStyle = dark ? "#fafafa" : "#18181b";
        ctx.lineWidth = 2;
      };
      const hlRow = (it: Row, y: number) => {
        if (hl?.has(rowKey(it))) {
          hlStyle();
          ctx.strokeRect(1.5, y + 1.5, width - 3, rowH - 3);
        }
      };
      const spinFrame = SPIN[spinTick % SPIN.length] ?? "";
      for (let i = s; i < e; i++) {
        const y = i * rowH;
        const it = rows[i]!;
        const nx = rows[i + 1];
        const key = rowKey(it);
        const twisty = collapsible.has(it) ? (collapsed.has(key) ? "shut" : "open") : null;
        const dim = loading?.has(key) ?? false;
        const bareRow = bare?.has(i) ?? false;
        drawCell(
          ctx,
          it.left,
          nx?.left ?? null,
          it.left ? it.status : "same",
          0,
          mid,
          y,
          rowH,
          twisty,
          dark,
          dim,
          bareRow,
          worldL,
          mid - worldL,
          spinFrame,
        );
        drawCell(
          ctx,
          it.right,
          nx?.right ?? null,
          it.right ? it.status : "same",
          mid,
          width - mid,
          y,
          rowH,
          twisty,
          dark,
          dim,
          bareRow,
          mid,
          worldR - mid,
          spinFrame,
        );
        hlRow(it, y);
        hlRow(it, y);
        ctx.fillStyle = chrome.hairline;
        if (it.left) ctx.fillRect(worldL, y + rowH - 1, mid - worldL, 1);
        if (it.right) ctx.fillRect(mid, y + rowH - 1, worldR - mid, 1);
        if (hover === i) {
          ctx.fillStyle = chrome.hoverBg;
          if (it.left) ctx.fillRect(worldL, y, mid - worldL, rowH);
          if (it.right) ctx.fillRect(mid, y, worldR - mid, rowH);
        }
      }
      // Sticky parents: ancestors of the top-visible row pinned to the
      // viewport top, same cells as the tree. World Y for screen row j is
      // j*rowH - cam.y/k, so it stays fixed while the camera scrolls.
      for (let j = 0; j < sticky.length; j++) {
        const i = sticky[j] ?? -1;
        const it = rows[i]!;
        if (i < 0 || !it) continue;
        const nx = rows[i + 1];
        const y = j * rowH - cam.y / cam.k;
        const key = rowKey(it);
        const twisty = collapsible.has(it) ? (collapsed.has(key) ? "shut" : "open") : null;
        const dim = loading?.has(key) ?? false;
        const bareRow = bare?.has(i) ?? false;
        drawCell(
          ctx,
          it.left,
          nx?.left ?? null,
          it.left ? it.status : "same",
          0,
          mid,
          y,
          rowH,
          twisty,
          dark,
          dim,
          bareRow,
          worldL,
          mid - worldL,
          spinFrame,
        );
        drawCell(
          ctx,
          it.right,
          nx?.right ?? null,
          it.right ? it.status : "same",
          mid,
          width - mid,
          y,
          rowH,
          twisty,
          dark,
          dim,
          bareRow,
          mid,
          worldR - mid,
          spinFrame,
        );
        hlRow(it, y);
        ctx.fillStyle = chrome.hairline;
        if (it.left) ctx.fillRect(worldL, y + rowH - 1, mid - worldL, 1);
        if (it.right) ctx.fillRect(mid, y + rowH - 1, worldR - mid, 1);
        if (hover === i) {
          ctx.fillStyle = chrome.hoverBg;
          if (it.left) ctx.fillRect(worldL, y, mid - worldL, rowH);
          if (it.right) ctx.fillRect(mid, y, worldR - mid, rowH);
        }
      }
      // No outer frame: row hairlines already bound the body.
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [
    rows,
    cam,
    width,
    rowH,
    collapsed,
    collapsible,
    hover,
    sticky,
    iconTick,
    dark,
    hl,
    loading,
    bare,
    spinTick,
  ]);

  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={`${rows.length} diff rows`}
      className="absolute inset-0 h-full w-full"
    />
  );
}
