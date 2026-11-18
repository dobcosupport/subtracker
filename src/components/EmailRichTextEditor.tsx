"use client";

import { useEffect, useRef, useState } from "react";
import { INSERTABLE_MERGE_FIELDS, MERGE_FIELD_LABELS, type MergeField } from "@/lib/communication-templates";
import { sanitizeEmailBodyClient } from "@/lib/email-rich-text";
import styles from "./email-workspace.module.css";

type Props = {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
};

const commands = [
  { label: "Bold", command: "bold", symbol: "B" },
  { label: "Italic", command: "italic", symbol: "I" },
  { label: "Underline", command: "underline", symbol: "U" },
  { label: "Bulleted list", command: "insertUnorderedList", symbol: "• List" },
  { label: "Numbered list", command: "insertOrderedList", symbol: "1. List" },
] as const;

export default function EmailRichTextEditor({ id, label, value, disabled = false, onChange }: Props) {
  const editor = useRef<HTMLDivElement>(null);
  const savedSelection = useRef<Range | null>(null);
  const lastEmitted = useRef<string | null>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const element = editor.current;
    if (!element) return;
    const safe = sanitizeEmailBodyClient(value);
    if (safe === lastEmitted.current) {
      lastEmitted.current = null;
      return;
    }
    if (element.innerHTML !== safe) element.innerHTML = safe;
  }, [value]);

  function emitSanitized() {
    const element = editor.current;
    if (!element) return;
    const safe = sanitizeEmailBodyClient(element.innerHTML);
    if (safe !== element.innerHTML) element.innerHTML = safe;
    if (safe.length > 100000) {
      setNotice("Body is limited to 100,000 characters.");
      element.innerHTML = sanitizeEmailBodyClient(value);
      return;
    }
    setNotice("");
    lastEmitted.current = safe;
    onChange(safe);
  }

  function saveSelection() {
    const selection = window.getSelection();
    if (selection?.rangeCount && editor.current?.contains(selection.anchorNode)) {
      savedSelection.current = selection.getRangeAt(0).cloneRange();
    }
  }

  function restoreSelection() {
    const range = savedSelection.current;
    const selection = window.getSelection();
    if (!range || !selection || !editor.current?.contains(range.commonAncestorContainer)) {
      editor.current?.focus();
      return;
    }
    selection.removeAllRanges();
    selection.addRange(range);
    editor.current?.focus();
  }

  function runCommand(command: string) {
    restoreSelection();
    document.execCommand(command, false);
    emitSanitized();
  }

  function insertField(field: MergeField) {
    restoreSelection();
    document.execCommand("insertText", false, `{{${field}}}`);
    savedSelection.current = null;
    emitSanitized();
  }

  function insertLink() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.toString()) {
      setNotice("Select text in the Body before adding a link.");
      editor.current?.focus();
      return;
    }
    const href = window.prompt("Link address (https, http, mailto, or tel)");
    if (href === null) return;
    if (!/^(?:https?:\/\/|mailto:|tel:)/i.test(href.trim())) {
      setNotice("Use an http, https, mailto, or tel link.");
      return;
    }
    saveSelection();
    restoreSelection();
    document.execCommand("createLink", false, href.trim());
    emitSanitized();
    setNotice("");
  }

  function paste(event: React.ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();
    const html = event.clipboardData.getData("text/html");
    const text = event.clipboardData.getData("text/plain");
    const safe = sanitizeEmailBodyClient(html || text);
    restoreSelection();
    document.execCommand("insertHTML", false, safe);
    emitSanitized();
  }

  return <div className={styles.richEditor}>
    <label className={styles.richLabel} htmlFor={id}>{label}</label>
    <div className={styles.richToolbar} role="toolbar" aria-label={`${label} formatting`}>
      {commands.map(item => <button key={item.command} type="button" disabled={disabled} aria-label={item.label}
        title={item.label} onMouseDown={event => { event.preventDefault(); saveSelection(); }}
        onClick={() => runCommand(item.command)}>{item.symbol}</button>)}
      <button type="button" disabled={disabled} aria-label="Add link" title="Link"
        onMouseDown={event => { event.preventDefault(); saveSelection(); }} onClick={insertLink}>Link</button>
      <span className={styles.toolbarDivider} aria-hidden="true" />
      <button type="button" disabled={disabled} aria-label="Undo" title="Undo"
        onMouseDown={event => { event.preventDefault(); saveSelection(); }} onClick={() => runCommand("undo")}>↶</button>
      <button type="button" disabled={disabled} aria-label="Redo" title="Redo"
        onMouseDown={event => { event.preventDefault(); saveSelection(); }} onClick={() => runCommand("redo")}>↷</button>
      <button type="button" disabled={disabled} aria-label="Clear formatting" title="Clear formatting"
        onMouseDown={event => { event.preventDefault(); saveSelection(); }}
        onClick={() => { runCommand("removeFormat"); runCommand("unlink"); }}>Clear</button>
      <label className={styles.insertField}>
        <span className={styles.visuallyHidden}>Insert merge field into {label}</span>
        <select aria-label={`Insert field into ${label}`} disabled={disabled} value="" onFocus={saveSelection} onMouseDown={saveSelection}
          onChange={event => {
            const field = INSERTABLE_MERGE_FIELDS.find(candidate => candidate === event.target.value);
            if (field) insertField(field);
          }}>
          <option value="" disabled>Insert Field ▾</option>
          {INSERTABLE_MERGE_FIELDS.map(field => <option key={field} value={field}>{MERGE_FIELD_LABELS[field]}</option>)}
        </select>
      </label>
    </div>
    <div id={id} ref={editor} className={styles.richTextArea} role="textbox" aria-multiline="true"
      aria-label={label} contentEditable={!disabled} suppressContentEditableWarning
      data-placeholder="Write your message..." onInput={emitSanitized} onPaste={paste}
      onKeyUp={saveSelection} onMouseUp={saveSelection} />
    {notice ? <p className={styles.editorNotice} role="status">{notice}</p> : null}
  </div>;
}
