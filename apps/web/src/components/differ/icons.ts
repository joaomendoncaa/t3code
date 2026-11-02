// Differ icon helpers. T3 web has no codicons or icon server, so KINDS stays
// empty (DiffCanvas renders text-only) and images load through this cache.
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
