import type * as acp from "@agentclientprotocol/sdk";

/**
 * A form field as the browser renders it. ACP's schema is normalized once on the server so the
 * event, the room snapshot and the browser all agree on what can be answered.
 */
export type ElicitationField =
  | {
      kind: "string";
      name: string;
      title: string;
      description?: string;
      required: boolean;
      options?: ElicitationOption[];
      minLength?: number | null;
      maxLength?: number | null;
      pattern?: string | null;
      format?: string | null;
      default?: string;
    }
  | {
      kind: "number";
      name: string;
      title: string;
      description?: string;
      required: boolean;
      minimum?: number | null;
      maximum?: number | null;
      default?: number;
    }
  | {
      kind: "integer";
      name: string;
      title: string;
      description?: string;
      required: boolean;
      minimum?: number | null;
      maximum?: number | null;
      default?: number;
    }
  | {
      kind: "boolean";
      name: string;
      title: string;
      description?: string;
      required: boolean;
      default?: boolean;
    }
  | {
      kind: "multi";
      name: string;
      title: string;
      description?: string;
      required: boolean;
      options: ElicitationOption[];
      minItems?: number | null;
      maxItems?: number | null;
      default?: string[];
    }
  | {
      /** A future ACP property type. Shown read-only; it must block accepting the form. */
      kind: "unsupported";
      name: string;
      title: string;
      description?: string;
      required: boolean;
      type: string;
    };

export interface ElicitationOption {
  value: string;
  label: string;
  description?: string;
}

export type ElicitationValue = string | number | boolean | string[];
export type ElicitationValues = Record<string, ElicitationValue | string | undefined>;

export type ElicitationIssueCode =
  | "required"
  | "invalid"
  | "min_length"
  | "max_length"
  | "pattern"
  | "format"
  | "minimum"
  | "maximum"
  | "option"
  | "min_items"
  | "max_items"
  | "unsupported";

export interface ElicitationIssue {
  code: ElicitationIssueCode;
  params?: Record<string, string | number>;
}

export type ElicitationIssues = Record<string, ElicitationIssue>;

export interface ElicitationValidation {
  /** Present only when no issue blocked the answer. */
  content: Record<string, ElicitationValue>;
  issues: ElicitationIssues;
  /** True when a field type cannot be rendered, so no complete answer can be produced. */
  blocked: boolean;
}

function optionsFromOneOf(value: unknown): ElicitationOption[] | undefined {
  if (!Array.isArray(value)) return;
  const options = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const option = item as { const?: unknown; title?: unknown; description?: unknown };
    if (typeof option.const !== "string" || !option.const) return [];
    return [
      {
        value: option.const,
        label: typeof option.title === "string" && option.title ? option.title : option.const,
        description: typeof option.description === "string" ? option.description : undefined,
      },
    ];
  });
  return options.length ? options : undefined;
}

function stringOptions(property: acp.StringPropertySchema): ElicitationOption[] | undefined {
  return optionsFromOneOf(property.oneOf) ?? property.enum?.map((value) => ({ value, label: value }));
}

function multiOptions(items: acp.MultiSelectItems | undefined): ElicitationOption[] | undefined {
  if (!items) return;
  if ("type" in items && items.type === "string") {
    const enumValues = (items as acp.StringMultiSelectItems).enum;
    if (Array.isArray(enumValues)) return enumValues.map((value) => ({ value, label: value }));
    return;
  }
  return optionsFromOneOf((items as acp.TitledMultiSelectItems).anyOf);
}

/** Normalize a validated ACP form schema. Unknown property types are kept so they can block submit. */
export function elicitationFields(schema: acp.ElicitationSchema | null | undefined): ElicitationField[] {
  const required = new Set(schema?.required ?? []);
  const properties = schema?.properties ?? {};
  return Object.entries(properties).map(([name, property]): ElicitationField => {
    const raw = property as { title?: unknown; description?: unknown; type?: unknown };
    const base = {
      name,
      title: typeof raw.title === "string" && raw.title ? raw.title : name,
      description: typeof raw.description === "string" ? raw.description : undefined,
      required: required.has(name),
    };
    switch (property.type) {
      case "string": {
        const p = property as acp.StringPropertySchema;
        return {
          ...base,
          kind: "string",
          options: stringOptions(p),
          minLength: p.minLength,
          maxLength: p.maxLength,
          pattern: p.pattern,
          format: p.format,
          default: p.default ?? undefined,
        };
      }
      case "number":
      case "integer": {
        const p = property as acp.NumberPropertySchema | acp.IntegerPropertySchema;
        return {
          ...base,
          kind: property.type,
          minimum: p.minimum,
          maximum: p.maximum,
          default: p.default ?? undefined,
        };
      }
      case "boolean": {
        const p = property as acp.BooleanPropertySchema;
        return { ...base, kind: "boolean", default: p.default ?? undefined };
      }
      case "array": {
        const p = property as acp.MultiSelectPropertySchema;
        const options = multiOptions(p.items);
        if (!options)
          return {
            ...base,
            kind: "unsupported",
            type: `${"type" in p.items ? p.items.type : "unknown"}[]`,
          };
        return {
          ...base,
          kind: "multi",
          options,
          minItems: p.minItems,
          maxItems: p.maxItems,
          default: p.default ?? undefined,
        };
      }
      default:
        return {
          ...base,
          kind: "unsupported",
          type: typeof raw.type === "string" ? raw.type : "unknown",
        };
    }
  });
}

function missing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  // Date.parse normalizes impossible dates such as February 30 instead of rejecting them.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validFormat(format: string, value: string): boolean {
  switch (format) {
    case "email":
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
    case "uri":
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case "date":
      return validDate(value);
    case "date-time":
      return (
        /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/i.test(
          value,
        ) && validDate(value.slice(0, 10))
      );
    default:
      // ACP may add formats later; an unknown format must not reject otherwise valid input.
      return true;
  }
}

/**
 * Validate the whole form. The browser uses this for inline errors; the server uses the same
 * function again before resolving the ACP request, so a hand-built request cannot bypass it.
 */
export function validateElicitation(fields: ElicitationField[], values: ElicitationValues): ElicitationValidation {
  const content: Record<string, ElicitationValue> = {};
  const issues: ElicitationIssues = {};
  let blocked = false;
  for (const field of fields) {
    const value = values[field.name];
    if (field.kind === "unsupported") {
      blocked = true;
      issues[field.name] = { code: "unsupported", params: { type: field.type } };
      continue;
    }
    if (field.kind === "boolean") {
      if (value === undefined || value === null || value === "") {
        if (field.required) issues[field.name] = { code: "required" };
        continue;
      }
      if (typeof value !== "boolean") {
        issues[field.name] = { code: "invalid" };
        continue;
      }
      content[field.name] = value;
      continue;
    }
    if (field.kind === "multi") {
      if (missing(value) || (Array.isArray(value) && value.length === 0)) {
        if (field.required) issues[field.name] = { code: "required" };
        continue;
      }
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        issues[field.name] = { code: "invalid" };
        continue;
      }
      const selected = value as string[];
      const allowed = new Set(field.options.map((option) => option.value));
      if (selected.some((item) => !allowed.has(item))) {
        issues[field.name] = { code: "option" };
        continue;
      }
      if (selected.length < (field.minItems ?? 0)) {
        issues[field.name] = { code: "min_items", params: { min: field.minItems ?? 0 } };
        continue;
      }
      if (field.maxItems != null && selected.length > field.maxItems) {
        issues[field.name] = { code: "max_items", params: { max: field.maxItems } };
        continue;
      }
      content[field.name] = [...selected];
      continue;
    }
    if (field.kind === "number" || field.kind === "integer") {
      if (missing(value)) {
        if (field.required) issues[field.name] = { code: "required" };
        continue;
      }
      if (typeof value !== "number" && typeof value !== "string") {
        issues[field.name] = { code: "invalid" };
        continue;
      }
      const number = typeof value === "number" ? value : Number(value.trim());
      if (!Number.isFinite(number) || (field.kind === "integer" && !Number.isInteger(number))) {
        issues[field.name] = { code: "invalid" };
        continue;
      }
      if (field.minimum != null && number < field.minimum) {
        issues[field.name] = { code: "minimum", params: { min: field.minimum } };
        continue;
      }
      if (field.maximum != null && number > field.maximum) {
        issues[field.name] = { code: "maximum", params: { max: field.maximum } };
        continue;
      }
      content[field.name] = number;
      continue;
    }
    if (missing(value)) {
      if (field.required) issues[field.name] = { code: "required" };
      continue;
    }
    if (typeof value !== "string") {
      issues[field.name] = { code: "invalid" };
      continue;
    }
    if (field.options && !field.options.some((option) => option.value === value)) {
      issues[field.name] = { code: "option" };
      continue;
    }
    const length = Array.from(value).length;
    if (field.minLength != null && length < field.minLength) {
      issues[field.name] = { code: "min_length", params: { min: field.minLength } };
      continue;
    }
    if (field.maxLength != null && length > field.maxLength) {
      issues[field.name] = { code: "max_length", params: { max: field.maxLength } };
      continue;
    }
    if (field.pattern) {
      let matched = true;
      try {
        matched = new RegExp(field.pattern).test(value);
      } catch {
        // An invalid agent-supplied pattern must not make the form unusable.
      }
      if (!matched) {
        issues[field.name] = { code: "pattern" };
        continue;
      }
    }
    if (field.format && !validFormat(field.format, value)) {
      issues[field.name] = { code: "format", params: { format: field.format } };
      continue;
    }
    content[field.name] = value;
  }
  return { content, issues, blocked };
}
