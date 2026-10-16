import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Locator } from "playwright-core";

/** Built React UI + real Registry installs/ACP. Pass the authFile given to mockRegistry({ authFile }). */
export async function registryAuthSmoke(browser: Browser, base: string, authFile: string, shotsDir?: string) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  const authPath = `/api/harnesses/${encodeURIComponent("reg:mock-bin")}/authenticate`;
  const attempts: { path: string; methodId: string }[] = [];
  const probes = { "mock-bin": 0, "mock-key": 0 };
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`registry auth fixture ${method} ${path}: ${response.status}`);
    return response;
  };
  const shot = async (name: string) => {
    if (shotsDir) {
      mkdirSync(shotsDir, { recursive: true });
      await page.screenshot({ path: join(shotsDir, `${name}.png`) });
    }
  };
  const enabled = async (button: Locator) => {
    await page.waitForFunction((element) => !(element as HTMLButtonElement).disabled, await button.elementHandle());
  };
  const assertNotReady = async (item: Locator) => {
    if (await item.getByRole("status").filter({ hasText: "可以用了" }).count())
      throw new Error("Registry claimed readiness before a confirmed session");
    if (await item.locator("[role=status].ok-text").count())
      throw new Error("Registry painted an unconfirmed login green");
  };
  const assertLocked = async (item: Locator) => {
    for (const button of await item.getByRole("button").all()) {
      if ((await button.getAttribute("aria-label"))?.startsWith("复制")) continue;
      if (!(await button.isDisabled()))
        throw new Error(`Registry operation left ${await button.textContent()} enabled`);
    }
  };
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (!["error", "warning"].includes(message.type())) return;
    // A deliberate HTTP 503 below must be visible in the UI; Chromium also logs that response.
    if (message.location().url === `${base}${authPath}` && message.text().includes("503")) return;
    // The local CDN intentionally omits the six curated logos; RegistryIcon falls back to initials.
    const curatedIcon = new RegExp(
      `${base}/api/registry/icon/(claude-acp|codex-acp|grok-build|opencode|pi-acp|minimax-code)$`,
    );
    if (curatedIcon.test(message.location().url) && message.text().includes("404")) return;
    errors.push(`${message.type()}: ${message.text()} (${message.location().url})`);
  });
  page.on("request", (req) => {
    const path = decodeURIComponent(new URL(req.url()).pathname);
    for (const id of ["mock-bin", "mock-key"] as const) if (path === `/api/harnesses/reg:${id}/test`) probes[id]++;
  });
  try {
    rmSync(authFile, { force: true });
    await request("POST", "/api/registry/refresh");
    for (const id of ["mock-bin", "mock-key"])
      await request("DELETE", `/api/harnesses/${encodeURIComponent(`reg:${id}`)}/managed`);
    await request("PUT", `/api/harnesses/${encodeURIComponent("reg:mock-key")}/env`, {
      values: { MOCK_API_KEY: null },
    });
    await page.goto(`${base}/#/harness`);
    await page.getByRole("heading", { name: "Harness 管理", exact: true }).waitFor();
    if (!page.url().endsWith("/#/harness") || !(await page.title()).includes("团团"))
      throw new Error("Registry auth smoke opened the wrong page");
    if (await page.locator("vite-error-overlay").count()) throw new Error("Registry page has a Vite overlay");
    const more = page.locator("section", { has: page.getByRole("heading", { name: "更多 Agent", exact: true }) });
    const search = more.getByLabel("搜索 Agent");
    await search.fill("Mock 二进制");
    const item = more.getByRole("article", { name: "Mock 二进制", exact: true });
    await item.getByRole("button", { name: "安装", exact: true }).click();
    const login = item.getByRole("button", { name: "用「Mock 登录」登录", exact: true });
    await login.waitFor({ timeout: 60_000 });
    await enabled(login);
    if (probes["mock-bin"] !== 1) throw new Error("Registry install did not automatically handshake exactly once");
    await item.getByRole("status").filter({ hasText: "需要登录" }).waitFor();
    await assertNotReady(item);
    const snapshot = await (await request("POST", `/api/harnesses/${encodeURIComponent("reg:mock-bin")}/test`)).json();
    // Names and IDs advertised by Antigravity 1.4.0; no real OAuth runs in this layout fixture.
    const advertisedMethods = [
      { id: "oauth-personal", name: "Log in with Google" },
      { id: "oauth-business", name: "Log in with Gemini Enterprise" },
      { id: "gemini-api-key", name: "Gemini API key" },
      { id: "agent-platform", name: "Gemini Enterprise Agent Platform" },
    ];
    const layoutProbe = {
      ...snapshot,
      authMethods: advertisedMethods.map((method) => ({ ...method, type: "agent", command: null, vars: null })),
    };
    const testPath = `/api/harnesses/${encodeURIComponent("reg:mock-bin")}/test`;
    const layoutAttempts: string[] = [];
    await page.route(`${base}${testPath}`, (route) => route.fulfill({ json: layoutProbe }));
    await page.route(`${base}${authPath}`, (route) => {
      layoutAttempts.push(route.request().postDataJSON().methodId);
      return route.fulfill({ json: layoutProbe });
    });
    await item.getByRole("button", { name: "握手", exact: true }).click();
    await item.getByRole("button", { name: "用「Log in with Google」登录", exact: true }).waitFor();
    const layoutWidths = [1440, 900, 430, 390];
    for (const width of layoutWidths) {
      await page.setViewportSize({ width, height: 900 });
      await item.scrollIntoViewIfNeeded();
      if (width === 1440) {
        const columns = await item.evaluate((element) =>
          getComputedStyle(element.parentElement as Element)
            .gridTemplateColumns.trim()
            .split(/\s+/),
        );
        if (columns.length !== 2) throw new Error(`Registry method layout expected two desktop columns: ${columns}`);
      }
      for (const method of advertisedMethods) {
        const button = item.getByRole("button", { name: `用「${method.name}」登录`, exact: true });
        await enabled(button);
        const geometry = await button.evaluate((element) => {
          const card = element.closest("article")?.getBoundingClientRect();
          const rect = element.getBoundingClientRect();
          const icon = element.querySelector("svg")?.getBoundingClientRect();
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          const textRects: DOMRect[] = [];
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const range = document.createRange();
            range.selectNodeContents(node);
            textRects.push(...range.getClientRects());
          }
          return {
            cardWidth: card?.width,
            buttonWidth: rect.width,
            contained: !!card && rect.left >= card.left && rect.right <= card.right,
            textContained: textRects.every(
              (text) =>
                text.left >= rect.left &&
                text.right <= rect.right &&
                text.top >= rect.top &&
                text.bottom <= rect.bottom,
            ),
            iconWidth: icon?.width,
          };
        });
        if (!geometry.contained || !geometry.textContained || (geometry.iconWidth ?? 0) < 12)
          throw new Error(`Registry ${width}px method ${method.name} overflows: ${JSON.stringify(geometry)}`);
        const answered = page.waitForResponse(`${base}${authPath}`);
        await button.click();
        await answered;
        await enabled(button);
      }
      await shot(`registry-auth-methods-${width}`);
    }
    if (layoutAttempts.join() !== layoutWidths.flatMap(() => advertisedMethods.map((method) => method.id)).join())
      throw new Error(`Advertised method controls did not submit their full method IDs: ${layoutAttempts}`);
    await page.unroute(`${base}${testPath}`);
    await page.unroute(`${base}${authPath}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await item.getByRole("button", { name: "握手", exact: true }).click();
    await login.waitFor();
    await enabled(login);
    let mode: "rejected" | "http" | "unknown" | "missing-key" | "success" = "rejected";
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    await page.route(`${base}${authPath}`, async (route) => {
      const req = route.request();
      attempts.push({ path: new URL(req.url()).pathname, methodId: req.postDataJSON().methodId });
      if (mode === "success") return route.continue();
      if (mode === "rejected") {
        arrived();
        await gate;
        return route.fulfill({ json: { ...snapshot, authError: "Mock 登录被拒绝，请重试" } });
      }
      if (mode === "http") return route.fulfill({ status: 503, json: { error: "Mock 登录服务暂时不可用" } });
      if (mode === "missing-key")
        return route.fulfill({
          json: {
            ...snapshot,
            sessionError:
              "auth.type is set to 'gemini-api-key', but the GEMINI_API_KEY environment variable is not set. Set GEMINI_API_KEY before starting.",
          },
        });
      return route.fulfill({
        json: { ...snapshot, loggedIn: null, authError: null, sessionError: "Mock session/new 暂时不可用" },
      });
    });
    // Native rapid clicks exercise the request lock before React can render a disabled button.
    await login.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await waiting;
    await item.getByRole("status").filter({ hasText: "等待「Mock 登录」登录完成" }).waitFor();
    await assertLocked(item);
    await assertNotReady(item);
    if (attempts.length !== 1) throw new Error("Repeated login clicks issued duplicate authenticate requests");
    await item.scrollIntoViewIfNeeded();
    await shot("registry-auth-waiting");
    release();
    await item.getByRole("alert").filter({ hasText: "Mock 登录被拒绝，请重试" }).waitFor();
    await enabled(login);
    await assertNotReady(item);
    await shot("registry-auth-retry");

    mode = "http";
    await login.click();
    await item.getByRole("status").filter({ hasText: "Mock 登录服务暂时不可用" }).waitFor();
    await enabled(login);
    await assertNotReady(item);

    mode = "unknown";
    await login.click();
    await item.getByRole("status").filter({ hasText: "登录状态未知" }).waitFor();
    await item.getByRole("alert").filter({ hasText: "Mock session/new 暂时不可用" }).waitFor();
    await enabled(login);
    await assertNotReady(item);
    await page.setViewportSize({ width: 430, height: 900 });
    await item.scrollIntoViewIfNeeded();
    const contained = await login.evaluate((element) => {
      const card = element.closest("article")?.getBoundingClientRect();
      const button = element.getBoundingClientRect();
      return !!card && button.left >= card.left && button.right <= card.right;
    });
    if (!contained) throw new Error("Registry login button overflows its card at 430px");
    await shot("registry-auth-unknown-mobile");
    await page.setViewportSize({ width: 1440, height: 900 });

    mode = "success";
    await login.click();
    await item.getByRole("status").filter({ hasText: "可以用了" }).waitFor();
    await login.waitFor({ state: "hidden" });
    await shot("registry-auth-ready");
    // Already-installed, logged-out harnesses offer the same methods after an explicit handshake.
    rmSync(authFile, { force: true });
    await page.reload();
    await search.fill("Mock 二进制");
    await item.getByRole("button", { name: "握手", exact: true }).click();
    await login.waitFor();
    await enabled(login);
    await login.click();
    await item.getByRole("status").filter({ hasText: "可以用了" }).waitFor();
    await item.getByRole("button", { name: "握手", exact: true }).click();
    await item.getByRole("status").filter({ hasText: "可以用了" }).waitFor();
    await enabled(item.getByRole("button", { name: "握手", exact: true }));
    if (await login.count()) throw new Error("A ready harness is being forced to log in again");
    if (Number(attempts.length) !== 5 || attempts.some((a) => a.path !== authPath || a.methodId !== "mock-login"))
      throw new Error(`Registry sent the wrong authenticate method/path: ${JSON.stringify(attempts)}`);

    // Some agents expose only agent-driven methods and name the required key in a later session error.
    rmSync(authFile, { force: true });
    await page.reload();
    await search.fill("Mock 二进制");
    await item.getByRole("button", { name: "握手", exact: true }).click();
    await login.waitFor();
    await enabled(login);
    mode = "missing-key";
    await login.click();
    const requiredKey = item.getByLabel("GEMINI_API_KEY", { exact: true });
    await requiredKey.waitFor();
    await enabled(item.getByRole("button", { name: "握手", exact: true }));
    await item.getByRole("status").filter({ hasText: "需要 API Key" }).waitFor();
    await assertNotReady(item);
    await item.scrollIntoViewIfNeeded();
    await shot("registry-agent-required-key");
    await requiredKey.fill("sk-registry-gemini-test-525252");
    const binEnvPath = `/api/harnesses/${encodeURIComponent("reg:mock-bin")}/env`;
    await page.route(`${base}${binEnvPath}`, async (route) => {
      const values = route.request().postDataJSON().values;
      if (values.GEMINI_API_KEY !== "sk-registry-gemini-test-525252")
        throw new Error("Required key field did not save the explicitly named variable");
      const response = await route.fetch();
      // The synthetic missing-key error above is resolved; the following handshake is real ACP.
      writeFileSync(authFile, "ok");
      await route.fulfill({ response });
    });
    const beforeRequiredKey = probes["mock-bin"];
    await item.getByRole("button", { name: "保存", exact: true }).click();
    await item.getByRole("status").filter({ hasText: "可以用了" }).waitFor();
    await enabled(item.getByRole("button", { name: "握手", exact: true }));
    if (probes["mock-bin"] !== beforeRequiredKey + 1)
      throw new Error("Saving an error-named API key did not handshake exactly once");
    if (!(await requiredKey.getAttribute("placeholder"))?.includes("5252"))
      throw new Error("Error-named API key did not persist with a masked hint");
    await page.unroute(`${base}${binEnvPath}`);

    await search.fill("Mock 密钥");
    const keyItem = more.getByRole("article", { name: "Mock 密钥", exact: true });
    await keyItem.getByRole("button", { name: "安装", exact: true }).click();
    await keyItem.getByRole("status").filter({ hasText: "需要 API Key" }).waitFor({ timeout: 60_000 });
    const keyInput = keyItem.getByLabel("MOCK_API_KEY", { exact: true });
    await keyInput.fill("sk-registry-test-424242");
    const save = keyItem.getByRole("button", { name: "保存", exact: true });
    await enabled(save);
    let releaseKey: () => void = () => {};
    const keyGate = new Promise<void>((resolve) => {
      releaseKey = resolve;
    });
    const keyPath = `/api/harnesses/${encodeURIComponent("reg:mock-key")}/env`;
    await page.route(`${base}${keyPath}`, async (route) => {
      await keyGate;
      await route.continue();
    });
    await save.click();
    await assertLocked(keyItem);
    if (!(await keyInput.isDisabled())) throw new Error("API key input remained editable during save");
    releaseKey();
    await keyItem.getByRole("status").filter({ hasText: "可以用了" }).waitFor();
    await enabled(keyItem.getByRole("button", { name: "握手", exact: true }));
    if (probes["mock-key"] !== 2) throw new Error("Saving a Registry API key did not handshake exactly once");
    if ((await keyInput.inputValue()) !== "") throw new Error("Saved API key remained visible in the input");
    if (!(await keyInput.getAttribute("placeholder"))?.includes("4242"))
      throw new Error("Saved API key did not render its masked hint");
    await keyItem.getByRole("button", { name: "在终端中打开「Mock 设置」", exact: true }).waitFor();
    await keyItem.scrollIntoViewIfNeeded();
    await shot("registry-env-ready");
    if (errors.length) throw new Error(`Registry auth browser errors: ${errors.join("; ")}`);
  } catch (error) {
    await shot("registry-auth-failure").catch(() => {});
    throw error;
  } finally {
    await page.close();
    for (const id of ["mock-bin", "mock-key"])
      await request("DELETE", `/api/harnesses/${encodeURIComponent(`reg:${id}`)}/managed`);
    await request("PUT", `/api/harnesses/${encodeURIComponent("reg:mock-key")}/env`, {
      values: { MOCK_API_KEY: null },
    });
    await request("PUT", `/api/harnesses/${encodeURIComponent("reg:mock-bin")}/env`, {
      values: { GEMINI_API_KEY: null },
    });
    rmSync(authFile, { force: true });
  }
}
