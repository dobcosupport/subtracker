import Style3Icon from "./Style3Icon";
import styles from "./operations.module.css";

export default function Style3SummaryCards<T extends string>({ label, items, selected, onSelect, unavailable }: {
  label: string;
  items: readonly { key: T; label: string; value: number; note: string; icon: string }[];
  selected: T;
  onSelect: (key: T) => void;
  unavailable: boolean;
}) {
  return <section className={styles.summary} aria-label={label}>
    {items.map(item => <button key={item.key} type="button" className={styles.summaryCard}
      aria-pressed={selected === item.key} onClick={() => onSelect(item.key)} disabled={unavailable}>
      <Style3Icon name={item.icon} className={styles.summaryIcon} />
      <div><h2>{item.label}</h2><strong>{unavailable ? "\u2014" : item.value.toLocaleString()}</strong><p>{item.note}</p></div>
    </button>)}
  </section>;
}
