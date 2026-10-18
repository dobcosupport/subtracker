import LogsPanel from "@/components/LogsPanel";

export default async function LogsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  return <LogsPanel initialTab={tab === "communications" ? "communications" : "audit"} />;
}
