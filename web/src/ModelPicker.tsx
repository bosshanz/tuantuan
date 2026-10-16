import { BRAND_SVG } from "./brandIcons";
import { BRAND_LABEL, type Brand, brandFor } from "./brands";
import { useI18n } from "./i18n";

export { type Brand, brandFor };

/** Official vendor mark (mono, currentColor); unknown models get a neutral chip glyph. */
export function BrandLogo({ brand, size = 14 }: { brand: Brand; size?: number }) {
  const { t } = useI18n();
  const svg = BRAND_SVG[brand];
  const label = brand === "generic" ? t("其他模型") : BRAND_LABEL[brand];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      fillRule="evenodd"
      role="img"
      aria-label={label}
      className={`brand-logo brand-${brand}`}
    >
      <title>{label}</title>
      {svg ? (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static vendor marks bundled with the app
        <g dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <g fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6" y="6" width="12" height="12" rx="2.5" />
          <path d="M9.5 2.5v3M14.5 2.5v3M9.5 18.5v3M14.5 18.5v3M2.5 9.5h3M2.5 14.5h3M18.5 9.5h3M18.5 14.5h3" />
        </g>
      )}
    </svg>
  );
}
