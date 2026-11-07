import type { ReactNode } from "react";
import styles from "./style3.module.css";

export default function Style3Panel({ title, description, children }: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return <section className={styles.panel}>
    <h2 className={styles.heading}>{title}</h2>
    {description ? <p className={styles.description}>{description}</p> : null}
    {children}
  </section>;
}
