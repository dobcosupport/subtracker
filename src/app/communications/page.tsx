import { redirect } from "next/navigation";

export default function CommunicationsPage() {
  redirect("/admin/audit?tab=communications");
}
