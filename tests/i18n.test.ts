import { expect, test } from "bun:test";
import { serve } from "../server/app";
import { DEFAULT_PROFILE, ProfileSchema, profileInstructions } from "../server/profile";
import { intlLocale, isLocale, LOCALES, messages, translate, translateError } from "../shared/i18n";
import { notifyForMessage } from "../shared/notify";
import { previewText, type RoomPreview } from "../shared/roomPreview";
import { choiceLabel } from "../web/src/config";
import { getLocale, setLocale } from "../web/src/i18n";
import { until } from "./helpers";

const tokens = (text: string) => [...new Set(text.match(/\{[a-zA-Z][\w]*\}/g) ?? [])].sort();

test("toggle-only thinking labels preserve the control meaning in every locale", () => {
  const previous = getLocale();
  try {
    for (const locale of LOCALES) {
      setLocale(locale);
      expect(choiceLabel("effort", "high", "On")).toBe(translate(locale, "开"));
      expect(choiceLabel("effort", "high", "High")).toBe(translate(locale, "高"));
      expect(choiceLabel("effort", "off", "Off")).toBe(translate(locale, "关"));
      expect(choiceLabel("model", "high", "On")).toBe("On");
    }
  } finally {
    setLocale(previous);
  }
});

test("every registered message has complete translations with the same placeholders", () => {
  expect(Object.keys(messages).length).toBeGreaterThan(500);
  for (const [source, translations] of Object.entries(messages)) {
    for (const locale of LOCALES.filter((l) => l !== "zh-CN")) {
      expect(translations[locale].trim(), `${locale}: ${source}`).not.toBe("");
      expect(tokens(translations[locale]), `${locale}: ${source}`).toEqual(tokens(source));
    }
  }
});

test("interpolation preserves user values literally and unknown copy falls back", () => {
  expect(translate("en", "{name} 设置", { name: "中文项目 {count} $&" })).toBe("中文项目 {count} $& settings");
  expect(translate("zh-CN", "{name} 设置", { name: "Alpha" })).toBe("Alpha 设置");
  expect(translate("ja", "unknown resource text")).toBe("unknown resource text");
  expect(translate("en", "{name} 设置")).toBe("{name} settings");
  expect(intlLocale("ja")).toBe("ja-JP");
  expect(isLocale("fr")).toBe(false);
});

test("only known error templates are localized; paths, names and external diagnostics are retained", () => {
  expect(translateError("en", "服务商不存在")).toBe("Provider not found");
  const path = "/Users/小明/项目 [draft]";
  const source = `文件夹不存在：${path}`;
  expect(translateError("en", source)).toContain(path);
  expect(translateError("en", source)).not.toContain("文件夹不存在");
  expect(translateError("ja", "服务器错误：服务商不存在")).not.toContain("服务商不存在");
  const external = 'HTTP 429: upstream says "服务商不存在", retry-after=60';
  expect(translateError("en", external)).toBe(external);
  expect(translateError("zh-CN", source)).toBe(source);
});

test("UI locale never changes profile instructions or actual message previews", () => {
  const profile = { ...DEFAULT_PROFILE, name: "小明", about: "请用中文回答", timezone: "Asia/Shanghai" };
  for (const language of LOCALES) {
    const parsed = ProfileSchema.parse({ ...profile, language });
    expect(parsed.language).toBe(language);
    expect(profileInstructions(parsed)).toBe(profileInstructions(profile));
  }
  const last: RoomPreview = { messageId: "m", seq: 1, sender: null, text: "正在回复…", at: 0, status: "done" };
  expect(previewText(last, "en")).toBe("正在回复…");
  expect(previewText({ ...last, text: "", status: "streaming" }, "en")).toBe("Responding…");
  const message = {
    id: "m",
    senderKind: "agent",
    senderId: "a",
    senderName: "小助手",
    status: "done",
    content: "你好，English 日本語",
    error: null,
  };
  expect(notifyForMessage("r", message, "ja")).toMatchObject({ agentName: "小助手", text: message.content });
  expect(notifyForMessage("r", { ...message, content: "" }, "en")).toMatchObject({ text: "(Empty reply)" });
});

test("profile API accepts all locales, broadcasts saved language and rejects unsupported values without overwriting", async () => {
  const { app, server } = serve({ dbPath: ":memory:" }, 0);
  const url = `http://127.0.0.1:${server.port}`;
  const events: Array<{ type: string; profile?: { language: string; about: string } }> = [];
  const socket = new WebSocket(`${url.replace("http:", "ws:")}/ws`);
  socket.onmessage = (event) => events.push(JSON.parse(String(event.data)));
  try {
    await until(() => socket.readyState === WebSocket.OPEN);
    for (const language of LOCALES) {
      const response = await fetch(`${url}/api/profile`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...DEFAULT_PROFILE, language, name: "小明", about: "原始文本" }),
      });
      expect(response.status).toBe(200);
      await until(() =>
        events.some((event) => event.type === "profile.updated" && event.profile?.language === language),
      );
      const saved = await (await fetch(`${url}/api/profile`)).json();
      expect(saved).toMatchObject({ language, name: "小明", about: "原始文本" });
    }
    const invalid = await fetch(`${url}/api/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...DEFAULT_PROFILE, language: "unsupported" }),
    });
    expect(invalid.status).toBe(400);
    expect(await (await fetch(`${url}/api/profile`)).json()).toMatchObject({ language: "ja", about: "原始文本" });
    expect(events.filter((event) => event.type === "profile.updated")).toHaveLength(4);
  } finally {
    socket.close();
    app.host.shutdown();
    server.stop(true);
  }
});
