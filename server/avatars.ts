/**
 * Agent avatars: a small set of hand-authored "bot" silhouettes (100×100 viewBox) filled with one
 * colour, plus two slanted eye strokes. Shared by server (defaults) and web (rendering).
 */
export const AVATAR_SHAPES = [
  "orb",
  "cloud",
  "tile",
  "spark",
  "clover",
  "bean",
  "flower",
  "drop",
  "pill",
  "wedge",
  "gem",
  "burst",
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
};

/** Muted pigments first (the default set), then a few brighter inks. */
export const AVATAR_COLORS = [
  "#2f4a6d",
  "#2f6b6b",
  "#3d6b4f",
  "#6f7a3a",
  "#b0812a",
  "#b0432a",
  "#a8476b",
  "#6d3f5b",
  "#7a5a3c",
  "#4f5d63",
  "#2a2722",
  "#2f7de1",
  "#e0662e",
] as const;
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
    shape: AVATAR_SHAPES[h % AVATAR_SHAPES.length] as AvatarShape,
    color: AVATAR_COLORS[(h >>> 8) % DEFAULT_COLOR_COUNT] as string,
  };
}

export function isAvatarShape(s: unknown): s is AvatarShape {
  return typeof s === "string" && (AVATAR_SHAPES as readonly string[]).includes(s);
}
