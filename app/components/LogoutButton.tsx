"use client";
import { useRouter } from "next/navigation";

export function LogoutButton() {
  const router = useRouter();
  const logout = async () => {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  };
  return (
    <button onClick={logout} className="text-xs" style={{ color: "var(--text-dim)" }}>
      Sign out
    </button>
  );
}
