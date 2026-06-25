import { LiveFeed } from "../components/LiveFeed";

export const dynamic = "force-dynamic";

export default function LogsPage() {
  return (
    <main className="p-4 max-w-3xl mx-auto">
      <h1 className="font-bold mb-4">LOGS — LIVE FEED</h1>
      <LiveFeed />
    </main>
  );
}
