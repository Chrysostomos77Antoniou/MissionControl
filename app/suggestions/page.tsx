import { SuggestionsFeed } from "../components/SuggestionsFeed";

export const dynamic = "force-dynamic";

export default function SuggestionsPage() {
  return (
    <main className="p-4 max-w-3xl mx-auto">
      <h1 className="font-bold mb-4">SUGGESTIONS INBOX</h1>
      <SuggestionsFeed />
    </main>
  );
}
