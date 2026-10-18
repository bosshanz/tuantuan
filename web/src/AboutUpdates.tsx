import { Download, ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopUpdateStatus } from "../../shared/desktopUpdate";
import { BrandMark } from "./BrandMark";
import { intlLocale, translateError, useI18n } from "./i18n";
import { updateBridge } from "./notifications";
import "./aboutUpdates.css";

export function AboutUpdates() {
  const { t, locale } = useI18n();
  const desktop = updateBridge();
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const revision = useRef(0);
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    const started = revision.current;
    const off = desktop.onUpdateState((next) => {
      ++revision.current;
      if (alive) setStatus(next);
    });
    void desktop.updateStatus().then(
      (next) => {
        if (alive && started === revision.current) setStatus(next);
      },
      (error) => {
        if (alive) setError((error as Error).message);
      },
    );
    return () => {
      alive = false;
      off();
    };
  }, [desktop]);
  const run = async (action: () => Promise<DesktopUpdateStatus | undefined>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    const started = revision.current;
    try {
      const next = await action();
      if (next && started === revision.current) setStatus(next);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  };
  const working = pending || status?.phase === "checking" || status?.phase === "installing";
  const canInstall = status?.phase === "ready" && status.activity === "idle";
  const progress = Math.round(Math.max(0, Math.min(100, status?.progress ?? 0)));
  const phaseLabel = status
    ? {
        idle: status.checkedAt ? t("已是最新版本") : t("检查是否有新版本可用。"),
        checking: t("正在检查更新…"),
        available: t("新版本 {version} 可用", { version: status.availableVersion ?? "" }),
        downloading: t("正在下载更新…"),
        ready: t("更新已下载，可以重启更新。"),
        installing: t("正在保存工作并重启…"),
        error: t("更新未完成，请重试。"),
      }[status.phase]
    : t("加载中…");
  return (
    <>
      <header className="main-head">
        <div className="title">
          <h2>{t("关于与更新")}</h2>
        </div>
      </header>
      <div className="page">
        <div className="page-inner about-updates">
          <section className="card">
            <div className="card-head about-brand">
              <BrandMark size={38} />
              <h3>{t("团团 Tuantuan")}</h3>
            </div>
            <div className="card-body">
              {status && <p className="muted">{t("当前版本 {version}", { version: status.version })}</p>}
              {status?.availableVersion && ["downloading", "ready", "installing"].includes(status.phase) && (
                <p className="muted">{t("新版本 {version} 可用", { version: status.availableVersion })}</p>
              )}
              {!desktop ? (
                <p className="muted">{t("应用更新仅桌面版支持。浏览器使用当前服务提供的版本。")}</p>
              ) : status?.mode === "disabled" ? (
                <p className="muted">
                  {status.reason === "development" ? t("开发版不提供应用更新。") : t("此版本已停用应用更新。")}
                </p>
              ) : (
                <>
                  {status?.mode === "manual" && (
                    <div className="update-help">
                      <p className="muted">
                        {status.reason === "homebrew"
                          ? t("通过 Homebrew 安装，请在终端运行以下命令升级。")
                          : t("此安装方式需要手动更新。检查新版本后，可打开下载页面安装。")}
                      </p>
                      {status.reason === "homebrew" && <code>brew upgrade --cask tuantuan</code>}
                    </div>
                  )}
                  <p role="status" className="update-status">
                    {phaseLabel}
                  </p>
                  {status?.phase === "downloading" && (
                    <div className="update-progress">
                      <progress max={100} value={progress} aria-label={t("下载进度")} />
                      <span>{progress}%</span>
                    </div>
                  )}
                  {status?.mode === "automatic" && status.phase === "ready" && (
                    <p className={status.activity === "idle" ? "muted" : "warn-text"} id="update-install-help">
                      {status.activity === "busy"
                        ? t("仍有 {count} 项 Agent 任务，结束后才能重启更新。", { count: status.activeTasks })
                        : status.activity === "unknown"
                          ? t("无法确认 Agent 任务状态，恢复连接后才能重启更新。")
                          : t("重启前会保存聊天草稿、引用和阅读位置。")}
                    </p>
                  )}
                  <div className="row update-actions">
                    <button
                      type="button"
                      className="btn"
                      disabled={working || status?.phase === "downloading"}
                      onClick={() =>
                        desktop && void run(() => (status ? desktop.checkForUpdates() : desktop.updateStatus()))
                      }
                    >
                      <RefreshCw size={15} />
                      {t("检查更新")}
                    </button>
                    {status?.mode === "automatic" &&
                      (status.phase === "available" || (status.phase === "error" && status.availableVersion)) && (
                        <button
                          type="button"
                          className="btn primary"
                          disabled={working}
                          onClick={() => desktop && void run(() => desktop.downloadUpdate())}
                        >
                          <Download size={15} />
                          {t("下载更新")}
                        </button>
                      )}
                    {status?.mode === "automatic" && status.phase === "ready" && (
                      <>
                        <button
                          type="button"
                          className="btn primary"
                          disabled={working || !canInstall}
                          aria-describedby="update-install-help"
                          onClick={() => desktop && void run(() => desktop.installUpdate())}
                        >
                          <RotateCcw size={15} />
                          {t("重启更新")}
                        </button>
                        <button
                          type="button"
                          className="btn ghost"
                          disabled={working}
                          onClick={() => {
                            location.hash = "#/c";
                          }}
                        >
                          {t("稍后")}
                        </button>
                      </>
                    )}
                    {status?.mode === "manual" && (
                      <button
                        type="button"
                        className="btn"
                        disabled={working}
                        onClick={() =>
                          desktop &&
                          void run(async () => {
                            await desktop.openUpdateRelease();
                            return undefined;
                          })
                        }
                      >
                        <ExternalLink size={15} />
                        {t("打开下载页面")}
                      </button>
                    )}
                  </div>
                  {status?.checkedAt && (
                    <p className="muted update-checked">
                      {t("上次检查：{time}", { time: new Date(status.checkedAt).toLocaleString(intlLocale(locale)) })}
                    </p>
                  )}
                </>
              )}
              {(error || status?.error) && (
                <p className="error-text" role="alert">
                  {t("无法完成更新操作：{error}", { error: translateError(error ?? status?.error ?? "") })}
                </p>
              )}
            </div>
          </section>
          {status && status.mode !== "disabled" && (
            <section className="card">
              <div className="card-body">
                <label className="notify-row">
                  <span className="grow">
                    <b>{t("自动检查更新")}</b>
                    <span className="muted">{t("后台检查新版本，下载与重启由你决定。")}</span>
                  </span>
                  <input
                    type="checkbox"
                    className="tg"
                    aria-label={t("自动检查更新")}
                    checked={status.automaticChecks}
                    disabled={working}
                    onChange={(event) =>
                      void run(() => desktop?.setUpdateChecks(event.target.checked) ?? Promise.resolve(undefined))
                    }
                  />
                </label>
              </div>
            </section>
          )}
          {status?.releaseNotes && (
            <section className="card">
              <div className="card-head">
                <h3>{t("更新说明")}</h3>
              </div>
              <div className="card-body">
                <div className="update-notes">{status.releaseNotes}</div>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
