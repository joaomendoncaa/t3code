// Stable overview rail: one bar per filtered-tree node. Panel height maps
// 1:1 to camera space (collapsed runs keep their scroll space), so a node
// sits at the same Y no matter the zoom, pan, or fold state.
// Click/drag centers the camera exactly, even on collapsed gaps.
// Overview rail, vendored from the differ project
// (differ/src/components/Minimap.tsx). See DiffCanvas.tsx for the vendoring
// contract: verbatim logic, T3 adaptation in DifferTreeView.tsx.
import { useEffect, useRef } from "react";
import { STATUS_META, rowKey, type Row } from "./rows";
import { LIGHT_FG, type Cam } from "./DiffCanvas";

const SAME_BAR = "#3f3f46";
const SAME_BAR_LIGHT = "#d4d4d8";
const TRACK_BG = "rgba(9,9,11,0.75)";
const TRACK_BG_LIGHT = "rgba(244,244,245,0.9)";
const VIEW_FILL = "rgba(255,255,255,0.18)";
const VIEW_FILL_LIGHT = "rgba(0,0,0,0.12)";
const VIEW_BORDER = "#fafafa";
const VIEW_BORDER_LIGHT = "#18181b";

function barColor(cell: Row["left"], status: Row["status"], dark = true): string {
  if (!cell) return dark ? "#18181b" : "#e4e4e7";
  if (status === "same") return dark ? SAME_BAR : SAME_BAR_LIGHT;
  // Expanded code reads as one solid rectangle per hunk, not indented
  // tree bars: code slots take the full lane in their change color.
  if (cell.isCode) return dark ? STATUS_META[status].fg : LIGHT_FG[status];
  return dark ? STATUS_META[status].fg : LIGHT_FG[status];
}

// Tiny vertical margin so the viewport handles stay fully visible at the
// top/bottom limits without clamping their position.
const MINIMAP_PAD = 4;

// Track height divided by node count: node i sits at PAD + i * scale.
export function minimapScale(n: number, h: number): number {
  if (n <= 0 || h <= 0) return 2;
  const track = h - MINIMAP_PAD * 2;
  if (track <= 0) return 2;
  return track / n;
}

// Fixed step so nesting reads at 80px wide; clamped so deep nodes stay visible.
const MINI_INDENT = 3;

export function minimapBar(cell: Row["left"], laneX: number, laneW: number): [number, number] {
  if (!cell) return [laneX, laneW];
  if (cell.isCode) return [laneX, laneW];
  const x = laneX + cell.depth * MINI_INDENT;
  return [x, Math.max(2, laneX + laneW - x)];
}

export function minimapIndex(n: number, h: number, my: number): number {
  if (n <= 0 || h <= 0) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor((my - MINIMAP_PAD) / minimapScale(n, h))));
}

// Viewport window in minimap px, shared by draw + handle hit-testing.
// s inclusive, e exclusive, like the canvas renderer.
export function minimapViewport(
  n: number,
  h: number,
  cam: Cam,
  rowH: number,
  viewH: number,
): { s: number; e: number; ry: number; rh: number } {
  const scale = minimapScale(n, h);
  const s = Math.max(0, Math.floor((0 - cam.y) / cam.k / rowH));
  const e = Math.min(n, Math.ceil((viewH - cam.y) / cam.k / rowH));
  return { s, e, ry: MINIMAP_PAD + s * scale, rh: Math.max(8, (e - s) * scale) };
}

const HANDLE_HIT = 8;
const HANDLE_W = 28;
const HANDLE_H = 6;

function drawHandle(ctx: CanvasRenderingContext2D, w: number, cy: number, dark: boolean) {
  const hw = Math.min(HANDLE_W, w - 4);
  const hx = (w - hw) / 2;
  const hy = cy - HANDLE_H / 2;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(hx, hy, hw, HANDLE_H, 3);
  else ctx.rect(hx, hy, hw, HANDLE_H);
  ctx.fillStyle = dark ? VIEW_BORDER : VIEW_BORDER_LIGHT;
  ctx.fill();
}

export default function Minimap({
  full,
  cam,
  rowH,
  viewH,
  onJump,
  onRange,
  dark = true,
  hl = null,
}: {
  full: Row[];
  cam: Cam;
  rowH: number;
  viewH: number; // diff stage height, for the viewport rect
  onJump: (idx: number) => void;
  onRange?: (s: number, e: number) => void;
  dark?: boolean;
  hl?: Set<string> | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mode = useRef<null | "pan" | "top" | "bottom">(null);
  const anchor = useRef(0);

  useEffect(() => {
    const cv = ref.current;
    const wrap = wrapRef.current;
    if (!cv || !wrap) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      if (!w || !h) return;
      const bw = Math.round(w * dpr);
      const bh = Math.round(h * dpr);
      if (cv.width !== bw || cv.height !== bh) {
        cv.width = bw;
        cv.height = bh;
      }
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const n = full.length;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = dark ? TRACK_BG : TRACK_BG_LIGHT;
      ctx.fillRect(0, 0, w, h);
      if (n === 0) return;
      const scale = minimapScale(n, h);
      const mid = w / 2;
      const hlWash = (y: number, bh: number) => {
        ctx.fillStyle = dark ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.65)";
        ctx.fillRect(0, y, w, bh);
      };
      if (n <= h) {
        const bh2 = Math.max(1, scale * 0.8);
        const laneW = mid - 3;
        for (let i = 0; i < n; i++) {
          const y = MINIMAP_PAD + i * scale + (scale - bh2) / 2;
          const it = full[i]!;
          ctx.fillStyle = barColor(it.left, it.left ? it.status : "same", dark);
          const [lx, lw] = minimapBar(it.left, 2, laneW);
          ctx.fillRect(lx, y, lw, bh2);
          ctx.fillStyle = barColor(it.right, it.right ? it.status : "same", dark);
          const [rx, rw] = minimapBar(it.right, mid + 1, laneW);
          ctx.fillRect(rx, y, rw, bh2);
          if (hl?.has(rowKey(it))) hlWash(y, bh2);
        }
      } else {
        // More nodes than pixels: one rect per pixel, a changed node wins
        // its pixel so changes stay visible when everything is collapsed.
        // A highlighted node wins over everything.
        const pick: (Row | null)[] = new Array(h).fill(null);
        for (let i = 0; i < n; i++) {
          const py = Math.min(h - MINIMAP_PAD - 1, MINIMAP_PAD + Math.floor(i * scale));
          const cur = pick[py] ?? null;
          const r = full[i]!;
          if (!cur) pick[py] = r;
          else {
            const cb = hl?.has(rowKey(cur)) ? 1 : 0;
            const rb = hl?.has(rowKey(r)) ? 1 : 0;
            if (rb > cb || (rb === cb && cur.status === "same" && r.status !== "same"))
              pick[py] = r;
          }
        }
        for (let py = 0; py < h; py++) {
          const r = pick[py] ?? null;
          if (!r) continue;
          ctx.fillStyle = barColor(r.left, r.left ? r.status : "same", dark);
          const [lx, lw] = minimapBar(r.left, 2, mid - 3);
          ctx.fillRect(lx, py, lw, 1);
          ctx.fillStyle = barColor(r.right, r.right ? r.status : "same", dark);
          const [rx, rw] = minimapBar(r.right, mid + 1, mid - 3);
          ctx.fillRect(rx, py, rw, 1);
          if (hl?.has(rowKey(r))) hlWash(py, 1);
        }
      }
      // Viewport window, direct: camera space == full index space.
      const { s, e, ry, rh: rhgt } = minimapViewport(n, h, cam, rowH, viewH);
      if (e > s) {
        const r = Math.min(4, (w - 1) / 2, (rhgt - 1) / 2);
        ctx.beginPath();
        if (typeof ctx.roundRect === "function") ctx.roundRect(0.5, ry + 0.5, w - 1, rhgt - 1, r);
        else ctx.rect(0.5, ry + 0.5, w - 1, rhgt - 1);
        ctx.fillStyle = dark ? VIEW_FILL : VIEW_FILL_LIGHT;
        ctx.fill();
        ctx.strokeStyle = dark ? VIEW_BORDER : VIEW_BORDER_LIGHT;
        ctx.lineWidth = 1;
        ctx.stroke();
        if (onRange) {
          drawHandle(ctx, w, ry + 0.5, dark);
          drawHandle(ctx, w, ry + rhgt - 0.5, dark);
        }
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [full, cam, rowH, viewH, dark, onRange, hl]);

  function idxFromEvent(e: React.PointerEvent): number {
    const wrap = wrapRef.current;
    if (!wrap) return 0;
    const rect = wrap.getBoundingClientRect();
    return minimapIndex(full.length, rect.height, e.clientY - rect.top);
  }

  function edgeFromEvent(e: { clientX: number; clientY: number }): "top" | "bottom" | null {
    if (!onRange) return null;
    const wrap = wrapRef.current;
    if (!wrap || full.length === 0) return null;
    const rect = wrap.getBoundingClientRect();
    const my = e.clientY - rect.top;
    // Pill-only grab: ignore drags that start outside the centered handle.
    const hw = Math.min(HANDLE_W, rect.width - 4);
    if (Math.abs(e.clientX - rect.left - rect.width / 2) > hw / 2 + HANDLE_HIT) return null;
    const { s, e: ve, ry, rh } = minimapViewport(full.length, rect.height, cam, rowH, viewH);
    if (ve <= s) return null;
    if (Math.abs(my - ry) <= HANDLE_HIT && Math.abs(my - (ry + rh)) <= HANDLE_HIT)
      return my < ry + rh / 2 ? "top" : "bottom";
    if (Math.abs(my - ry) <= HANDLE_HIT) return "top";
    if (Math.abs(my - (ry + rh)) <= HANDLE_HIT) return "bottom";
    return null;
  }

  return (
    <div
      ref={wrapRef}
      className="h-full w-full cursor-pointer touch-none"
      onPointerDown={(e) => {
        const edge = edgeFromEvent(e);
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        if (edge) {
          const wrap = wrapRef.current!;
          const rect = wrap.getBoundingClientRect();
          const { s, e: ve } = minimapViewport(full.length, rect.height, cam, rowH, viewH);
          mode.current = edge;
          anchor.current = edge === "top" ? ve : s;
          (e.currentTarget as HTMLElement).style.cursor = "ns-resize";
        } else {
          mode.current = "pan";
          onJump(idxFromEvent(e));
        }
      }}
      onPointerMove={(e) => {
        if (mode.current === "top" || mode.current === "bottom") {
          const idx = idxFromEvent(e);
          const a = anchor.current;
          if (mode.current === "top") onRange?.(Math.min(idx, a - 1), a);
          else onRange?.(a, Math.max(a + 1, idx + 1));
        } else if (mode.current === "pan") {
          onJump(idxFromEvent(e));
        } else if (onRange) {
          (e.currentTarget as HTMLElement).style.cursor = edgeFromEvent(e) ? "ns-resize" : "";
        }
      }}
      onPointerUp={(e) => {
        mode.current = null;
        (e.currentTarget as HTMLElement).style.cursor = "";
      }}
      onPointerCancel={(e) => {
        mode.current = null;
        (e.currentTarget as HTMLElement).style.cursor = "";
      }}
      onDoubleClick={(e) => {
        // Stretch to the edge: bottom handle extends to the last row,
        // top handle to the first, keeping the opposite edge anchored.
        const edge = edgeFromEvent(e);
        if (!edge || !onRange || full.length === 0) return;
        const wrap = wrapRef.current;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        const { s, e: ve } = minimapViewport(full.length, rect.height, cam, rowH, viewH);
        if (edge === "bottom") onRange(s, full.length);
        else onRange(0, ve);
      }}
    >
      <canvas ref={ref} role="img" aria-label="minimap overview" className="h-full w-full" />
    </div>
  );
}
