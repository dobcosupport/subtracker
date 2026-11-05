import DashboardFollowups from "@/components/DashboardFollowups";

export default function FollowupsPage() {
  return <main className="min-h-screen bg-[#f5f7fb] p-4 text-slate-800 sm:p-8">
    <div className="mx-auto max-w-6xl space-y-5">
      <h1 className="text-3xl font-semibold text-slate-900">Follow-Ups</h1>
      <DashboardFollowups page />
    </div>
  </main>;
}
