export default function Style3Chevron({ expanded = false }: { expanded?: boolean }) {
  return <span aria-hidden="true" className={`inline-block h-[18px] w-1 shrink-0 text-xs font-normal leading-[18px] transition-transform group-open/rail:rotate-90 ${expanded ? "rotate-90" : ""}`}>›</span>;
}
