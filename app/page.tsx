import { TopMenu } from "./components/TopMenu";
import { RoomsDashboard } from "./components/RoomsDashboard";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main className="p-4">
      <TopMenu />
      <RoomsDashboard />
    </main>
  );
}
