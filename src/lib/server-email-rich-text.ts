import "server-only";
import sanitizeHtml from "sanitize-html";
import { renderMessage, type MergeValues } from "@/lib/communication-templates";
import { EMAIL_RICH_TEXT_TAGS, escapeEmailHtml, prepareEmailBodySource } from "@/lib/email-rich-text";

const sanitizerOptions: sanitizeHtml.IOptions = {
  allowedTags: [...EMAIL_RICH_TEXT_TAGS],
  allowedAttributes: { a: ["href", "title"], span: ["style"] },
  allowedStyles: { span: { "text-decoration": [/^underline$/i] } },
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowProtocolRelative: false,
  transformTags: { div: "p" },
};

export function sanitizeEmailBody(value: string): string {
  return sanitizeHtml(prepareEmailBodySource(value), sanitizerOptions);
}

export function sanitizeEmailBodyInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (input.channel !== "email" || typeof input.body !== "string") return value;
  return { ...input, body: sanitizeEmailBody(input.body) };
}

export function renderEmailBody(value: string, values: MergeValues) {
  const sanitized = sanitizeEmailBody(value);
  const unresolved = new Set<string>();
  const linkedMergeField = /<[^>]*\{\{\s*([^{}]+?)\s*\}\}[^>]*>/g;
  for (const match of sanitized.matchAll(linkedMergeField)) unresolved.add(match[1].trim());
  const html = sanitizeHtml(sanitized, {
    ...sanitizerOptions,
    textFilter(text) {
      const rendered = renderMessage(text, values);
      rendered.unresolved.forEach(field => unresolved.add(field));
      return escapeEmailHtml(rendered.text);
    },
  });
  return { html, unresolved: [...unresolved] };
}
