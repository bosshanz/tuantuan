import { BatteryCharging } from "lucide-react";
import { useEffect, useState } from "react";
import { translateError, useI18n } from "./i18n";
import { bridge } from "./notifications";

export function TaskPowerSettings() {
  const { t } = useI18n();
  const desktop = bridge();
  const supported = !!desktop?.taskPowerStatus && !!desktop?.setTaskPower;
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(supported);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let off = false;
    if (!desktop?.taskPowerStatus) return;
    void desktop.taskPowerStatus().then(
      (status) => {
        if (off) return;
        setEnabled(status.enabled);
        setBusy(false);
      },
      (error) => {
        if (off) return;
        setError((error as Error).message);
        setBusy(false);
      },
    );
    return () => {
      off = true;
    };
  }, [desktop]);
  const update = async (value: boolean) => {
    if (!desktop?.setTaskPower) return;
    setBusy(true);
    setError(null);
    try {
      const status = await desktop.setTaskPower(value);
      setEnabled(status.enabled);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h3>{t("任务运行")}</h3>
      </div>
      <div className="card-body notify-list">
        <label className="notify-row" data-off={!supported || undefined}>
          <span className="notify-ico">
            <BatteryCharging size={15} />
          </span>
          <span className="grow">
            <b>{t("Agent 任务运行中阻止自动休眠")}</b>
            <span className="muted" id="task-power-help">
              {supported
                ? t("有任务运行时阻止系统自动休眠，屏幕仍可熄灭。所有任务结束后恢复。")
                : t("仅桌面版支持；浏览器无法控制系统休眠。")}
            </span>
          </span>
          <input
            type="checkbox"
            className="tg"
            aria-label={t("Agent 任务运行中阻止自动休眠")}
            aria-describedby="task-power-help"
            checked={enabled}
            disabled={!supported || busy}
            onChange={(event) => void update(event.target.checked)}
          />
        </label>
        {error && (
          <p className="error-text" role="alert">
            {t("无法更新休眠设置：{error}", { error: translateError(error) })}
          </p>
        )}
      </div>
    </section>
  );
}
