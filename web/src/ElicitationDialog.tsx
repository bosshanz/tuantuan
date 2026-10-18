import { ChevronRight } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
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
import "./ElicitationDialog.css";

const controlSelector = "input:not(:disabled), select:not(:disabled), textarea:not(:disabled)";

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

/** A pending ACP form stays mounted while collapsed, preserving answers and validation feedback. */
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
  const [expanded, setExpanded] = useState(false);
  const card = useRef<HTMLDetailsElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const summary = useRef<HTMLElement>(null);
  const titleId = useId();
  const unsupported = ask.fields.filter((field) => field.kind === "unsupported");
  useLayoutEffect(() => {
    const element = card.current;
    return () => {
      if (element?.contains(document.activeElement)) {
        element.closest(".composer")?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true });
      }
    };
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
    const invalidNames = Object.keys(result.issues);
    if (result.blocked || invalidNames.length) {
      requestAnimationFrame(() => {
        // A user can collapse or leave the card before this scheduled validation focus runs.
        if (!card.current?.open || form.current?.inert || !card.current.contains(document.activeElement)) return;
        const field = Array.from(form.current?.querySelectorAll<HTMLElement>("[data-elicit-field]") ?? []).find(
          (element) => element.dataset.elicitField === invalidNames[0],
        );
        field?.querySelector<HTMLElement>(controlSelector)?.focus();
      });
      return;
    }
    if (form.current?.contains(document.activeElement)) summary.current?.focus({ preventScroll: true });
    props.onAccept(result.content);
  };

  return (
    <details
      ref={card}
      className="elicit"
      open={expanded}
      aria-busy={props.pending}
      onKeyDown={(event) => {
        if (event.key === "Escape" && event.currentTarget.open) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(false);
          summary.current?.focus({ preventScroll: true });
        }
      }}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: native summary activation toggles open and inert together */}
      <summary
        ref={summary}
        className="elicit-summary"
        onClick={(event) => {
          event.preventDefault();
          setExpanded((current) => !current);
        }}
      >
        <span className="elicit-intro">
          <span className="elicit-agent">{tr("{name} 想请你回答", { name: props.agentName })}</span>
          <span className="elicit-message" id={titleId}>
            {ask.message}
          </span>
        </span>
        <span className="elicit-summary-actions">
          {(props.pending || props.error) && (
            <span className={`elicit-status${props.error ? " failed" : ""}`} role="status">
              {props.pending ? tr("提交中…") : tr("提交失败")}
            </span>
          )}
          <span className="elicit-disclosure">
            <span className="elicit-open-label">{tr("展开提问")}</span>
            <span className="elicit-close-label">{tr("收起提问")}</span>
            <ChevronRight size={16} aria-hidden />
          </span>
        </span>
      </summary>
      {/* JSON Schema patterns match substrings; native HTML constraints use different rules. */}
      <form
        ref={form}
        inert={!expanded}
        noValidate
        aria-labelledby={titleId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.pending && expanded) submit();
        }}
      >
        <div className="elicit-content">
          <p className="elicit-prompt">{ask.message}</p>
          <div className="elicit-fields">
            {unsupported.length > 0 && (
              <p className="elicit-form-error" role="alert">
                {tr("这个提问包含当前版本不支持的问题类型，无法提交。请取消本次提问。")}
              </p>
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
        </div>
        <footer className="elicit-footer">
          {props.error && (
            <p className="elicit-form-error" role="alert">
              {tr("回答提交失败：{reason}。请重试。", { reason: translateError(props.error) })}
            </p>
          )}
          <div className="elicit-actions">
            <button
              type="button"
              className="btn"
              disabled={props.pending}
              onClick={() => {
                if (form.current?.contains(document.activeElement)) summary.current?.focus({ preventScroll: true });
                props.onCancel();
              }}
            >
              {tr("取消提问")}
            </button>
            <button
              type="submit"
              className="btn primary"
              disabled={props.pending || unsupported.length > 0}
              aria-busy={props.pending}
            >
              {props.pending ? tr("提交中…") : tr("提交回答")}
            </button>
          </div>
        </footer>
      </form>
    </details>
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
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [field.description && helpId, props.issue && errorId].filter(Boolean).join(" ") || undefined;
  const label = (
    <label className="elicit-label" htmlFor={id}>
      {field.title}
      {field.required && (
        <span className="elicit-required" aria-hidden>
          *
        </span>
      )}
    </label>
  );
  const help = field.description && (
    <p className="elicit-help" id={helpId}>
      {field.description}
    </p>
  );
  const error = props.issue && (
    <p className="elicit-error" id={errorId} role="alert">
      {issueText(tr, props.issue)}
    </p>
  );
  const common = {
    id,
    disabled: props.disabled,
    "aria-invalid": props.issue ? true : undefined,
    "aria-describedby": describedBy,
  };
  if (field.kind === "unsupported")
    return (
      <div className="elicit-field elicit-unsupported" data-kind="unsupported" data-elicit-field={field.name}>
        {label}
        <input {...common} className="input" value={tr("不支持的问题类型")} disabled readOnly />
        {help}
        {error}
      </div>
    );
  if (field.kind === "boolean")
    return (
      <div className="elicit-field elicit-boolean" data-elicit-field={field.name}>
        <label className="elicit-choice">
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
        className="elicit-field elicit-group"
        data-elicit-field={field.name}
        disabled={props.disabled}
        aria-invalid={props.issue ? true : undefined}
        aria-describedby={describedBy}
      >
        <legend className="elicit-label">
          {field.title}
          {field.required && (
            <span className="elicit-required" aria-hidden>
              *
            </span>
          )}
        </legend>
        <div className="elicit-options">
          {field.options.map((option) => {
            const checked = selected.includes(option.value);
            return (
              <label className="elicit-choice" key={option.value}>
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
        </div>
        {help}
        {error}
      </fieldset>
    );
  }
  if (field.kind === "string" && field.options && field.options.length <= 4) {
    const options = field.required ? field.options : [{ value: "", label: tr("不填写") }, ...field.options];
    return (
      <fieldset
        className="elicit-field elicit-group"
        data-elicit-field={field.name}
        disabled={props.disabled}
        aria-invalid={props.issue ? true : undefined}
        aria-describedby={describedBy}
      >
        <legend className="elicit-label">
          {field.title}
          {field.required && (
            <span className="elicit-required" aria-hidden>
              *
            </span>
          )}
        </legend>
        <div className="elicit-options">
          {options.map((option) => (
            <label className="elicit-choice" key={option.value}>
              <input
                type="radio"
                name={id}
                value={option.value}
                checked={String(props.value ?? "") === option.value}
                onChange={() => props.onChange(option.value)}
              />
              <span>
                {option.label}
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
        </div>
        {help}
        {error}
      </fieldset>
    );
  }
  if (field.kind === "string" && field.options)
    return (
      <div className="elicit-field" data-elicit-field={field.name}>
        {label}
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
        {help}
        {error}
      </div>
    );
  if (field.kind === "string") {
    // Keep date-time as text: datetime-local strips the offset and cannot display RFC 3339 defaults.
    const type =
      field.format === "email" ? "email" : field.format === "uri" ? "url" : field.format === "date" ? "date" : "text";
    return (
      <div className="elicit-field" data-elicit-field={field.name}>
        {label}
        <input
          {...common}
          className="input"
          type={type}
          value={String(props.value ?? "")}
          onChange={(event) => props.onChange(event.target.value)}
        />
        {help}
        {error}
      </div>
    );
  }
  return (
    <div className="elicit-field" data-elicit-field={field.name}>
      {label}
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
      {help}
      {error}
    </div>
  );
}
