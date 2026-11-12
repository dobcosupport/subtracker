import shared from "@/components/style3/style3.module.css";
import styles from "@/components/style3/operations.module.css";
import Style3Icon from "@/components/style3/Style3Icon";

export default function DocumentsPage() {
  return <main className={shared.page}><div className={shared.content}>
    <div className={shared.contentHeader}><div><p className={shared.eyebrow}>Compliance Operations</p>
      <h1>Document Management</h1><p className={shared.description}>Documents stay connected to the records they support.</p>
    </div></div>
    <section className={styles.information} aria-labelledby="documents-information">
      <div className={styles.documentIcon}><Style3Icon name="Documents" /></div>
      <div><span className={`${shared.badge} ${shared.blue}`}>Record-based documents</span>
        <h2 id="documents-information" className={shared.heading}>Find documents with their authoritative records</h2>
        <p>Compliance documents currently remain associated with their contractor and compliance records.
          Continue reviewing them in those records so the document and its context stay together.</p>
        <p>Centralized Document Management will be defined separately. Uploads, folders and duplicate document storage are not available here.</p>
      </div>
    </section>
  </div></main>;
}
