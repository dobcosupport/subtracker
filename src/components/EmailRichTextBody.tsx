"use client";

import { emailBodyToPlainText } from "@/lib/email-rich-text";
import styles from "./email-workspace.module.css";

export default function EmailRichTextBody({ html, ariaLabel }: { html: string; ariaLabel?: string }) {
  return <div aria-label={ariaLabel} className={styles.richBody}>
    <div className={styles.previewBody} dangerouslySetInnerHTML={{ __html: html }} />
    <details className={styles.plainFallback}>
      <summary>Plain-text fallback</summary>
      <pre>{emailBodyToPlainText(html)}</pre>
    </details>
  </div>;
}
