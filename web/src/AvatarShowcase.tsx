import { useState } from "react";
import { AVATAR_COLORS, SELECTABLE_AVATAR_SHAPES, SHAPE_LABEL } from "../../server/avatars";
import { EXPRESSION_LABEL, EXPRESSIONS } from "./avatarState";
import { BotAvatar } from "./BotAvatar";
import { useI18n } from "./i18n";

/** Dev-only preview (#/dev/avatars): every shape × expression, with motion toggle and sizes. */
export function AvatarShowcase() {
  const { t } = useI18n();
  const [animate, setAnimate] = useState(true);
  const [size, setSize] = useState(48);
  const [pulse, setPulse] = useState(0);
  return (
    <div className="showcase">
      <header className="showcase-head">
        <h1>{t("Bot 头像")}</h1>
        <label className="switch">
          <input type="checkbox" checked={animate} onChange={(e) => setAnimate(e.target.checked)} />
          {t("动画")}
        </label>
        <div className="seg">
          {[18, 20, 32, 36, 48, 64].map((n) => (
            <button key={n} type="button" className="btn sm" aria-pressed={size === n} onClick={() => setSize(n)}>
              {n}px
            </button>
          ))}
        </div>
        <button type="button" className="btn sm" onClick={() => setPulse((p) => p + 1)}>
          {t("跳一下")}
        </button>
      </header>
      <table className="showcase-grid">
        <thead>
          <tr>
            <th />
            {EXPRESSIONS.map((e) => (
              <th key={e}>{t(EXPRESSION_LABEL[e])}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {SELECTABLE_AVATAR_SHAPES.map((s, i) => (
            <tr key={s}>
              <th>{t(SHAPE_LABEL[s])}</th>
              {EXPRESSIONS.map((e) => (
                <td key={e}>
                  <BotAvatar
                    shape={s}
                    color={AVATAR_COLORS[i % AVATAR_COLORS.length] as string}
                    size={size}
                    expression={e}
                    animate={animate}
                    pulse={pulse || undefined}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
