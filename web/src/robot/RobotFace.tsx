export type Face = "idle" | "listening" | "thinking" | "happy" | "sad" | "surprised" | "neutral" | "error";

/** SVG robot. Expressions and actions are pure CSS driven by data attributes (see styles.css). */
export function RobotFace(props: {
  face: Face;
  talking: boolean;
  action: string | null;
  tint: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="robot"
      data-face={props.face}
      data-talking={props.talking}
      data-action={props.action ?? undefined}
      style={{ ["--tint" as string]: props.tint }}
      aria-label={props.label}
      onClick={props.onClick}
    >
      <svg viewBox="0 0 320 340" aria-hidden>
        <ellipse className="robot-shadow" cx="160" cy="326" rx="92" ry="9" />
        <g className="body-group">
          <rect className="r-shell" x="62" y="238" width="24" height="58" rx="12" />
          <g className="arm-r">
            <rect className="r-shell" x="234" y="238" width="24" height="58" rx="12" />
          </g>
          <rect className="r-shell" x="92" y="226" width="136" height="88" rx="18" />
          <g className="r-grille">
            {[0, 1, 2, 3].map((i) => (
              <line key={i} x1="128" x2="192" y1={252 + i * 9} y2={252 + i * 9} />
            ))}
          </g>
          <circle className="r-accent" cx="160" cy="296" r="3.5" />
          <rect className="r-shell" x="144" y="210" width="32" height="22" rx="8" />
          <g className="head">
            <line x1="160" y1="58" x2="160" y2="30" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            <circle className="antenna-dot" cx="160" cy="24" r="5" />
            <rect className="r-shell" x="44" y="56" width="232" height="162" rx="40" />
            <rect className="r-screen" x="66" y="78" width="188" height="118" rx="22" />
            <g className="eyes">
              <ellipse className="eye r-feature" cx="122" cy="124" rx="14" ry="19" />
              <ellipse className="eye r-feature" cx="198" cy="124" rx="14" ry="19" />
            </g>
            <g className="mouth">
              <path className="mouth-shape m-smile r-line" d="M140 162 Q160 178 180 162" />
              <path className="mouth-shape m-grin r-feature" d="M134 158 Q160 190 186 158 Z" />
              <path className="mouth-shape m-flat r-line" d="M146 168 L174 168" />
              <path className="mouth-shape m-frown r-line" d="M140 176 Q160 160 180 176" />
              <ellipse className="mouth-shape m-o r-feature" cx="160" cy="168" rx="11" ry="13" />
              <ellipse className="mouth-shape m-o-small r-feature" cx="160" cy="168" rx="7" ry="6" />
              <ellipse className="mouth-shape m-talk r-feature" cx="160" cy="167" rx="17" ry="10" />
            </g>
          </g>
        </g>
      </svg>
    </button>
  );
}

/** How long each body action plays (ms); keeps CSS animations and JS cleanup in sync. */
export const ACTION_MS: Record<string, number> = {
  nod: 1000,
  shake_head: 1050,
  tilt: 1400,
  wave: 1600,
  look_around: 1600,
  dance: 2000,
};

export const FACE_LABEL: Record<Face | "speaking", string> = {
  idle: "待机",
  listening: "正在听",
  thinking: "思考中",
  speaking: "说话中",
  happy: "开心",
  sad: "难过",
  surprised: "惊讶",
  neutral: "平静",
  error: "出错了",
};

export const ACTION_LABEL: Record<string, string> = {
  nod: "点头",
  shake_head: "摇头",
  tilt: "歪头",
  wave: "挥手",
  look_around: "环顾四周",
  dance: "跳舞",
};
