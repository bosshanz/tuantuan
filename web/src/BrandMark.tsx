/** 团团 logo: two round bots huddled together, glancing at each other on hover. */
export function BrandMark({ size = 32 }: { size?: number }) {
  const eye = (x: number, y: number) => (
    <>
      <line x1={x - 8 + 1.6} y1={y - 6.5} x2={x - 8 - 1.6} y2={y + 6.5} />
      <line x1={x + 8 + 1.6} y1={y - 6.5} x2={x + 8 - 1.6} y2={y + 6.5} />
    </>
  );
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 100 100" aria-hidden focusable="false">
      <mask id="brand-cut">
        <rect width="100" height="100" fill="#fff" />
        <circle cx="34" cy="60" r="36" fill="#000" />
      </mask>
      <circle className="bm-red" cx="68" cy="40" r="30" mask="url(#brand-cut)" />
      <g className="bm-eyes bm-eyes-red">{eye(80, 38)}</g>
      <circle className="bm-ink" cx="34" cy="60" r="32" />
      <g className="bm-eyes bm-eyes-ink">{eye(38, 58)}</g>
    </svg>
  );
}
