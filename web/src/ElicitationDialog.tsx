import { AlertTriangle, CircleHelp, Send, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  type ElicitationField,
  type ElicitationIssue,
  type ElicitationIssues,
  type ElicitationValue,
  type ElicitationValues,
  validateElicitation,
} from "../../shared/elicitation";
import type { ElicitationAsk } from "./api";
import { translateError, useI18n } from "./i18n";

function initialValues(fields: ElicitationField[]): ElicitationValues {
  const values: ElicitationValues = {};
  for (const field of fields) {
    switch (field.kind) {
      case "string":
        values[field.name] = field.default ?? "";
        break;
      case "number":
      case "integer":
        values[field.name] = field.default != null ? String(field.default) : "";
        break;
      case "boolean":
        values[field.name] = field.default ?? false;
        break;
      case "multi":
        values[field.name] = field.default ?? [];
        break;
      case "unsupported":
        break;
    }
  }
  return values;
}

function issueText(tr: (source: string, params?: Record<string, string | number>) => string, issue: ElicitationIssue) {
  switch (issue.code) {
    case "required":
      return tr("此项为必填");
    case "invalid":
      return tr("请输入有效的值");
    case "min_length":
      return tr("至少输入 {min} 个字符", { min: issue.params?.min ?? 0 });
    case "max_length":
      return tr("最多输入 {max} 个字符", { max: issue.params?.max ?? 0 });
    case "pattern":
      return tr("格式不匹配");
    case "format":
      return tr("请输入有效的 {format}", { format: String(issue.params?.format ?? "") });
    case "minimum":
      return tr("不能小于 {min}", { min: issue.params?.min ?? 0 });
    case "maximum":
      return tr("不能大于 {max}", { max: issue.params?.max ?? 0 });
    case "option":
      return tr("请选择有效选项");
    case "min_items":
      return tr("至少选择 {min} 项", { min: issue.params?.min ?? 0 });
    case "max_items":
      return tr("最多选择 {max} 项", { max: issue.params?.max ?? 0 });
    case "unsupported":
      return tr("当前版本不支持的问题类型「{type}」，无法提交。请取消本次提问。", {
        type: String(issue.params?.type ?? ""),
      });
  }
}

/**
 * One ACP form elicitation. Closing (button or Escape) always answers cancel, so a user who does
 * not want to answer can never leave the harness waiting; a failed accept keeps the form open.
 */
export function ElicitationDialog(props: {
  ask: ElicitationAsk;
  agentName: string;
  pending: boolean;
  error: string | null;
  onAccept: (content: Record<string, ElicitationValue>) => void;
  onCancel: () => void;
}) {
  const { t: tr } = useI18n();
  const { ask } = props;
  const [values, setValues] = useState<ElicitationValues>(() => initialValues(ask.fields));
  const [issues, setIssues] = useState<ElicitationIssues>({});
  const form = useRef<HTMLFormElement>(null);
  const unsupported = ask.fields.filter((field) => field.kind === "unsupported");
  useEffect(() => {
    form.current
      ?.querySelector<HTMLElement>("input:not(:disabled), select:not(:disabled), textarea:not(:disabled)")
      ?.focus();
  }, []);

  const update = (name: string, value: ElicitationValue) => {
    setValues((current) => ({ ...current, [name]: value }));
    setIssues((current) => {
      if (!(name in current)) return current;
      const next = { ...current };
      delete next[name];
      return next;
    });
  };

  const submit = () => {
    const result = validateElicitation(ask.fields, values);
    setIssues(result.issues);
    if (result.blocked || Object.keys(result.issues).length) return;
    props.onAccept(result.content);
  };

  return (
    <div className="overlay perm-overlay">
      <div
        className="palette perm elicit"
        role="alertdialog"
        aria-modal="true"
        aria-label={tr("{name} 想请你回答", { name: props.agentName })}
        aria-busy={props.pending}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.pending) {
            event.preventDefault();
            props.onCancel();
          }
        }}
      >
        <form
          ref={form}
          onSubmit={(event) => {
            event.preventDefault();
            if (!props.pending) submit();
          }}
        >
          <div className="perm-head">
            <CircleHelp size={18} />
            <div>
              <strong>{tr("{name} 想请你回答", { name: props.agentName })}</strong>
              <p className="elicit-message">{ask.message}</p>
            </div>
            <button
              type="button"
              className="btn ghost icon elicit-close"
              aria-label={tr("关闭并取消提问")}
              title={tr("关闭并取消提问")}
              disabled={props.pending}
              onClick={props.onCancel}
            >
              <X size={16} />
            </button>
          </div>
          <div className="perm-body elicit-fields">
            {unsupported.length > 0 && (
              <div className="form-error" role="alert">
                <AlertTriangle size={14} />
                {tr("这个提问包含当前版本不支持的问题类型，无法提交。请取消本次提问。")}
              </div>
            )}
            {ask.fields.map((field) => (
              <ElicitationFieldView
                key={field.name}
                field={field}
                value={values[field.name]}
                issue={issues[field.name]}
                disabled={props.pending}
                onChange={(value) => update(field.name, value)}
                tr={tr}
              />
            ))}
          </div>
          {props.error && (
            <div className="form-error" role="alert">
              {tr("回答提交失败：{reason}。请重试。", { reason: translateError(props.error) })}
            </div>
          )}
          <div className="perm-actions">
            <button type="button" className="btn" disabled={props.pending} onClick={props.onCancel}>
              {tr("取消提问")}
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={props.pending || unsupported.length > 0}
              aria-busy={props.pending}
            >
              <Send size={14} />
              {props.pending ? tr("提交中…") : tr("提交回答")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ElicitationFieldView(props: {
  field: ElicitationField;
  value: ElicitationValue | string | undefined;
  issue?: ElicitationIssue;
  disabled: boolean;
  onChange: (value: ElicitationValue) => void;
  tr: (source: string, params?: Record<string, string | number>) => string;
}) {
  const { field, tr } = props;
  const id = useId();
  const errorId = `${id}-error`;
  const label = (
    <label className="label" htmlFor={id}>
      {field.title}
      {field.required && (
        <span className="elicit-required" aria-hidden>
          *
        </span>
      )}
    </label>
  );
  const help = field.description && <p className="help">{field.description}</p>;
  const error = props.issue && (
    <p className="elicit-error" id={errorId} role="alert">
      {issueText(tr, props.issue)}
    </p>
  );
  const common = {
    id,
    disabled: props.disabled,
    "aria-invalid": props.issue ? true : undefined,
    "aria-describedby": props.issue ? errorId : undefined,
  };
  if (field.kind === "unsupported")
    return (
      <div className="field elicit-unsupported" data-kind="unsupported">
        {label}
        {help}
        <input className="input" value={tr("不支持的问题类型")} disabled readOnly />
        {error}
      </div>
    );
  if (field.kind === "boolean")
    return (
      <div className="field elicit-boolean">
        <label className="elicit-check">
          <input
            {...common}
            type="checkbox"
            checked={props.value === true}
            onChange={(event) => props.onChange(event.target.checked)}
          />
          <span>
            {field.title}
            {field.required && (
              <span className="elicit-required" aria-hidden>
                *
              </span>
            )}
          </span>
        </label>
        {help}
        {error}
      </div>
    );
  if (field.kind === "multi") {
    const selected = Array.isArray(props.value) ? (props.value as string[]) : [];
    const limitReached = field.maxItems != null && selected.length >= field.maxItems;
    return (
      <fieldset
        className="field elicit-multi"
        disabled={props.disabled}
        aria-describedby={props.issue ? errorId : undefined}
      >
        <legend className="label">
          {field.title}
          {field.required && (
            <span className="elicit-required" aria-hidden>
              *
            </span>
          )}
        </legend>
        {help}
        {field.options.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <label className="elicit-check" key={option.value}>
              <input
                type="checkbox"
                checked={checked}
                disabled={props.disabled || (limitReached && !checked)}
                onChange={(event) =>
                  props.onChange(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((value) => value !== option.value),
                  )
                }
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          );
        })}
        {error}
      </fieldset>
    );
  }
  if (field.kind === "string" && field.options)
    return (
      <div className="field">
        {label}
        {help}
        <select
          {...common}
          className="input"
          value={String(props.value ?? "")}
          onChange={(e) => props.onChange(e.target.value)}
        >
          <option value="">{field.required ? tr("请选择") : tr("不填写")}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {error}
      </div>
    );
  if (field.kind === "string") {
    const type =
      field.format === "email"
        ? "email"
        : field.format === "uri"
          ? "url"
          : field.format === "date"
            ? "date"
            : field.format === "date-time"
              ? "datetime-local"
              : "text";
    return (
      <div className="field">
        {label}
        {help}
        <input
          {...common}
          className="input"
          type={type}
          value={String(props.value ?? "")}
          minLength={field.minLength ?? undefined}
          maxLength={field.maxLength ?? undefined}
          pattern={field.pattern ?? undefined}
          onChange={(event) => props.onChange(event.target.value)}
        />
        {error}
      </div>
    );
  }
  return (
    <div className="field">
      {label}
      {help}
      <input
        {...common}
        className="input"
        type="number"
        step={field.kind === "integer" ? 1 : "any"}
        value={String(props.value ?? "")}
        min={field.minimum ?? undefined}
        max={field.maximum ?? undefined}
        onChange={(event) => props.onChange(event.target.value)}
      />
      {error}
    </div>
  );
}
