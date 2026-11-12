import DashboardFollowups from "@/components/DashboardFollowups";
import shared from "@/components/style3/style3.module.css";

export default function FollowupsPage() {
  return <main className={shared.page}>
    <div className={shared.content}>
      <div className={shared.contentHeader}><div><p className={shared.eyebrow}>Compliance Operations</p>
        <h1>Follow-Ups</h1><p className={shared.description}>Your operational queue for company follow-ups.</p>
      </div></div>
      <DashboardFollowups page />
    </div>
  </main>;
}
