export const EMAIL_RICH_TEXT_TAGS = ["a", "b", "br", "div", "em", "i", "li", "ol", "p", "span", "strong", "u", "ul"] as const;

const richTagPattern = /<\/?(?:a|b|br|div|em|i|li|ol|p|span|strong|u|ul)\b/i;
const htmlTagPattern = /<\/?[a-z][^>]*>/i;

export function isSafeEmailLink(value: string): boolean {
  const href = value.trim().replace(/[\u0000-\u0020\u007f]/g, "");
  if (!href || href.startsWith("//") || href.includes("\\")) return false;
  if (/^(?:https?:|mailto:|tel:)/i.test(href)) return true;
  return /^(?:[./?#]|[^:]+$)/.test(href);
}

export function escapeEmailHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function prepareEmailBodySource(value: string): string {
  if (richTagPattern.test(value) || htmlTagPattern.test(value)) return value;
  return escapeEmailHtml(value).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>");
}

export function sanitizeEmailBodyClient(value: string): string {
  const source = prepareEmailBodySource(value);
  const document = new DOMParser().parseFromString(`<body>${source}</body>`, "text/html");
  const blocked = new Set(["script", "style", "iframe", "object", "embed", "svg", "math", "template"]);
  const allowed = new Set<string>(EMAIL_RICH_TEXT_TAGS);

  function clean(parent: Element | DocumentFragment) {
    for (const child of [...parent.childNodes]) {
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      const tag = element.tagName.toLowerCase();
      if (blocked.has(tag)) {
        element.remove();
        continue;
      }
      clean(element);
      if (!allowed.has(tag)) {
        element.replaceWith(...element.childNodes);
        continue;
      }
      const safeTag = tag === "div" ? "p" : tag;
      const safe = document.createElement(safeTag);
      if (tag === "a") {
        const href = element.getAttribute("href");
        const title = element.getAttribute("title");
        if (href && isSafeEmailLink(href)) safe.setAttribute("href", href);
        if (title) safe.setAttribute("title", title);
      } else if (tag === "span" && element.getAttribute("style")?.trim().toLowerCase() === "text-decoration: underline") {
        safe.setAttribute("style", "text-decoration: underline");
      }
      safe.append(...element.childNodes);
      element.replaceWith(safe);
    }
  }

  clean(document.body);
  return document.body.innerHTML;
}

export function emailBodyToPlainText(value: string): string {
  if (typeof DOMParser === "undefined") {
    return value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(?:p|li)>/gi, "\n")
      .replace(/<li(?:\s[^>]*)?>/gi, "- ").replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#39;/gi, "'")
      .replace(/\n{3,}/g, "\n\n").trim();
  }
  const document = new DOMParser().parseFromString(`<body>${sanitizeEmailBodyClient(value)}</body>`, "text/html");
  function collect(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return [...node.childNodes].map(collect).join("");
    const element = node as Element, tag = element.tagName.toLowerCase();
    if (tag === "br") return "\n";
    const content = [...element.childNodes].map(collect).join("");
    if (tag === "li") return `- ${content}\n`;
    return ["p", "ul", "ol"].includes(tag) ? `${content}\n` : content;
  }
  return [...document.body.childNodes].map(collect).join("").replace(/\n{3,}/g, "\n\n").trim();
}
