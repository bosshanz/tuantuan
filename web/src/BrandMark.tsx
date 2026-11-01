import { useId } from "react";

/**
 * 团团 mark: a larger graphite bot in front, a smaller coral bot peeking behind.
 * Rest pose already looks inward; hover (see styles) leans the glance closer.
 * Geometry is mirrored in web/public/favicon.svg and docs/brand/.
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  const maskId = `bm${useId().replace(/:/g, "")}`;
  const eye = (x: number, y: number) => (
    <>
      <line x1={x - 6.4} y1={y - 6.5} x2={x - 9.6} y2={y + 6.5} />
      <line x1={x + 9.6} y1={y - 6.5} x2={x + 6.4} y2={y + 6.5} />
    </>
  );
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden focusable="false">
      <mask id={maskId}>
        <rect width="100" height="100" fill="#fff" />
        <circle cx="33" cy="63" r="33" fill="#000" />
      </mask>
      <g className="bm-back" mask={`url(#${maskId})`}>
        <circle className="bm-red" cx="68" cy="32" r="24" />
        <g className="bm-eyes bm-eyes-red">{eye(62, 24)}</g>
      </g>
      <g className="bm-front">
        <circle className="bm-ink" cx="33" cy="63" r="30" />
        <g className="bm-eyes bm-eyes-ink">{eye(37, 56)}</g>
      </g>
    </svg>
  );
}
