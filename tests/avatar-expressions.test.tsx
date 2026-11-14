import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_SHAPES } from "../server/avatars";
import { EXPRESSIONS } from "../web/src/avatarState";
import { avatarTier, BotAvatar } from "../web/src/BotAvatar";

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

  test("size tiers: full motion from 28px, face only at 20-24px, still face + badge at 18px and below", () => {
    expect([16, 18, 20, 24, 28, 40].map(avatarTier)).toEqual(["static", "static", "subtle", "subtle", "full", "full"]);
    const tiny = (expression: "awaiting" | "sad" | "thinking") =>
      renderToStaticMarkup(<BotAvatar shape="dog" color="#3280d6" size={16} expression={expression} />);
    expect(tiny("awaiting")).toContain("ba-badge-awaiting");
    expect(tiny("sad")).toContain("ba-badge-error");
    expect(tiny("thinking")).not.toContain("ba-badge");
    const big = renderToStaticMarkup(<BotAvatar shape="dog" color="#3280d6" size={36} expression="awaiting" animate />);
    expect(big).toContain('data-tier="full"');
    expect(big).not.toContain("ba-badge");
  });

  test("motion is applied to one pose group around every silhouette", () => {
    for (const shape of AVATAR_SHAPES) {
      const markup = renderToStaticMarkup(<BotAvatar shape={shape} color="#3280d6" expression="working" animate />);
      expect(markup).toMatch(/<g class="ba-pose"><g class="ba-lean"><g class="ba-root"><g class="ba-body">/);
    }
  });

  test("pointer gaze wraps only the eyes while keeping mouths anchored to the face", () => {
    for (const expression of ["awaiting", "speaking", "sad"] as const) {
      const markup = renderToStaticMarkup(
        <BotAvatar shape="cow" color="#3280d6" size={48} followPointer expression={expression} />,
      );
      expect(markup).toMatch(/<g class="ba-gaze">[\s\S]*<\/g><(?:path|ellipse)[^>]*class="[^"]*ba-mouth/);
      const gazeStart = markup.indexOf('<g class="ba-gaze">');
      const mouthIdx = markup.indexOf('class="ba-mouth"');
      const altMouthIdx = markup.indexOf("ba-mouth");
      const targetIdx = mouthIdx >= 0 ? mouthIdx : altMouthIdx;
      expect(gazeStart).toBeGreaterThan(-1);
      expect(targetIdx).toBeGreaterThan(gazeStart);
      expect(markup.slice(gazeStart, targetIdx)).toContain("</g>");
    }
  });

  test("resting markup has no gaze transform so a still avatar matches the previous drawing", () => {
    const markup = renderToStaticMarkup(
      <BotAvatar shape="orb" color="#3280d6" size={48} followPointer expression="idle" />,
    );
    expect(markup).toContain('class="ba-gaze"');
    expect(markup).toContain('class="ba-lean"');
    expect(markup).not.toContain("data-gaze");
    expect(markup).not.toMatch(/ba-gaze[^>]*style/);
    expect(markup).not.toMatch(/ba-lean[^>]*style/);
  });
});
