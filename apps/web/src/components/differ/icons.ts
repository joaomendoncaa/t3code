// Icon helpers for the differ canvas tree.
//
// The differ project resolves symbol icons from @vscode/codicons and
// file/folder icons from its own /api/icon server. Neither exists in T3 web,
// so this module keeps the same interface with what T3 can offer today:
// no per-kind symbol art (KINDS stays empty; DiffCanvas already renders a
// null icon as text-only) and the shared image cache for any future data-URL
// icons the symbol-enrichment service provides.
//
// Deliberately _not_ a verbatim copy: importing differ's icons.tsx would pull
// @vscode/codicons (?raw SVG) into the web bundle.
const cache = new Map<string, HTMLImageElement>();
const subs = new Set<() => void>();

/** Symbol-kind art, keyed by differ kind (fn, struct, class, ...). Empty
 * until the symbol service ships its own icon set; DiffCanvas falls back to
 * text labels when a kind is absent here. */
export const KINDS: Record<string, { src: string; color: string }> = {};

/** File/folder theme icon name -> image src. Unused while rows carry no
 * `icon` field (the T3 adapter builds rows without server icon names). */
export const themeIcon = (_name: string): string => "";

/** Subscribe to "an icon finished loading" (canvas needs a redraw). */
export function onIconLoad(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

/** Decoded image for src, or null while it's still loading. */
export function iconImg(src: string): HTMLImageElement | null {
  if (!src) return null;
  let img = cache.get(src);
  if (!img) {
    img = new Image();
    img.onload = () => subs.forEach((f) => f());
    img.src = src;
    cache.set(src, img);
  }
  return img.complete && img.naturalWidth > 0 ? img : null;
}
