/**
 * Agent avatars: a small set of hand-authored "bot" silhouettes (100×100 viewBox) filled with one
 * colour, plus two slanted eye strokes. Shared by server (defaults) and web (rendering).
 */
/** Current choices for new avatars and deterministic defaults. */
export const SELECTABLE_AVATAR_SHAPES = [
  "orb",
  "cloud",
  "clover",
  "flower",
  "burst",
  "cat",
  "dog",
  "rabbit",
  "panda",
  "goat",
  "cow",
] as const;

/** Saved avatars remain valid and renderable after leaving the picker. */
export const AVATAR_SHAPES = [
  ...SELECTABLE_AVATAR_SHAPES,
  "tile",
  "spark",
  "bean",
  "drop",
  "pill",
  "wedge",
  "gem",
  "hex",
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const SHAPE_LABEL: Record<AvatarShape, string> = {
  orb: "圆球",
  cloud: "云朵",
  tile: "方块",
  spark: "星芒",
  clover: "四叶",
  bean: "豆子",
  flower: "花朵",
  drop: "水滴",
  pill: "胶囊",
  wedge: "三角",
  gem: "菱形",
  burst: "爆炸星",
  hex: "六边形",
  cat: "小猫",
  dog: "小狗",
  rabbit: "兔子",
  panda: "熊猫",
  goat: "山羊",
  cow: "小牛",
};

/** Vivid modern colours; the first ten are the default set. */
export const AVATAR_COLORS = [
  "#3d7bfa",
  "#13a594",
  "#2bb06a",
  "#86b51c",
  "#f5a30f",
  "#f2553c",
  "#ee4f97",
  "#9a5bea",
  "#ff7a1f",
  "#22a6dc",
  "#3a3a3c",
  "#a86b45",
  "#64748b",
] as const;

/** Paper & ink era palette → the vivid palette (same hue family), used by migration 5. */
export const LEGACY_AVATAR_COLORS: Record<string, string> = {
  "#2f4a6d": "#3d7bfa",
  "#2f6b6b": "#13a594",
  "#3d6b4f": "#2bb06a",
  "#6f7a3a": "#86b51c",
  "#b0812a": "#f5a30f",
  "#b0432a": "#f2553c",
  "#a8476b": "#ee4f97",
  "#6d3f5b": "#9a5bea",
  "#7a5a3c": "#ff7a1f",
  "#4f5d63": "#22a6dc",
  "#2a2722": "#3a3a3c",
  "#2f7de1": "#3d7bfa",
  "#e0662e": "#ff7a1f",
};
const DEFAULT_COLOR_COUNT = 10;

/** FNV-1a: stable across runtimes, good enough to spread ids over a dozen buckets. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export function defaultAvatar(id: string): { shape: AvatarShape; color: string } {
  const h = hash(id);
  return {
    shape: SELECTABLE_AVATAR_SHAPES[h % SELECTABLE_AVATAR_SHAPES.length] as AvatarShape,
    color: AVATAR_COLORS[(h >>> 8) % DEFAULT_COLOR_COUNT] as string,
  };
}

export function isAvatarShape(s: unknown): s is AvatarShape {
  return typeof s === "string" && (AVATAR_SHAPES as readonly string[]).includes(s);
}
