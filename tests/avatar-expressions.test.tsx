import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_SHAPES } from "../server/avatars";
import { EXPRESSIONS } from "../web/src/avatarState";
import { BotAvatar } from "../web/src/BotAvatar";

describe("avatar expressions", () => {
  test("each supported shape renders distinct, valid faces for all activity states", () => {
    for (const shape of AVATAR_SHAPES) {
      const faces = EXPRESSIONS.map((expression) => {
        const markup = renderToStaticMarkup(<BotAvatar shape={shape} color="#3280d6" expression={expression} />);
        expect(markup).toContain(`data-expr="${expression}"`);
        expect(markup).not.toMatch(/NaN|Infinity/);
        return markup.slice(markup.indexOf('<g class="ba-face">'));
      });
      expect(new Set(faces).size).toBe(EXPRESSIONS.length);
    }
  });

  test("the title's hover expression is limited to idle avatars", () => {
    const idle = renderToStaticMarkup(<BotAvatar shape="cat" color="#3280d6" reactToHover />);
    const busy = renderToStaticMarkup(
      <BotAvatar shape="cat" color="#3280d6" expression="thinking" animate reactToHover />,
    );
    expect(idle).toContain('class="ba-face-curious"');
    expect(busy).toContain('data-expr="thinking"');
    expect(busy).not.toContain('class="ba-face-curious"');
  });
});
