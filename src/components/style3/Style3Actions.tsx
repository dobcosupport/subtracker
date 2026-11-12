"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import shared from "./style3.module.css";

export default function Style3Actions({ label, className, children }: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const [position, setPosition] = useState<{ top: number; right: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!position) return;
    const anchor = trigger.current?.getBoundingClientRect();
    menu.current?.querySelector("button")?.focus({ preventScroll: true });
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setPosition(null); trigger.current?.focus(); }
    };
    const focusOutside = (event: FocusEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const close = () => setPosition(null);
    const closeOnScroll = () => {
      const bounds = trigger.current?.getBoundingClientRect();
      if (!bounds || bounds.top !== anchor?.top || bounds.right !== anchor?.right) setPosition(null);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("focusin", focusOutside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape);
      document.removeEventListener("focusin", focusOutside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [position]);

  return <>
    <button ref={trigger} type="button" className={className} aria-label={label} aria-expanded={!!position}
      onClick={() => {
        const rect = trigger.current!.getBoundingClientRect();
        setPosition(position ? null : { top: Math.min(rect.bottom + 5, window.innerHeight - 190), right: Math.max(8, window.innerWidth - rect.right) });
      }}>Actions <span aria-hidden="true">&#8964;</span></button>
    {position ? createPortal(<div ref={menu} className={`${shared.actionMenu} ${shared.floatingActions}`}
      role="group" aria-label={label} style={position}
      onClick={() => setPosition(null)}>{children}</div>, document.body) : null}
  </>;
}
