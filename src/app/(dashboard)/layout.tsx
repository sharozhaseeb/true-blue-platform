"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fetchWithAuth } from "@/lib/fetch-with-auth";

type NavUser = {
  firmId: string | null;
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [user, setUser] = useState<NavUser | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadUser() {
      const response = await fetchWithAuth("/api/auth/me");
      if (!response.ok) {
        return;
      }

      const data = await response.json();
      if (!cancelled) {
        setUser({ firmId: data.user?.firmId ?? null });
      }
    }

    void loadUser();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogout() {
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    router.push("/login");
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="border-b border-gray-200 bg-white">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-14 items-center justify-between">
            <div className="flex items-center gap-6">
              <Link href="/dashboard" className="text-lg font-semibold text-gray-900">
                True Blue
              </Link>
              <div className="flex items-center gap-1 text-sm">
                <Link
                  href="/dashboard"
                  className="rounded-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                >
                  Overview
                </Link>
                {user?.firmId && (
                  <Link
                    href="/dashboard/chat"
                    className="rounded-md px-3 py-1.5 text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                  >
                    Document Q&A
                  </Link>
                )}
              </div>
            </div>
            <button
              onClick={handleLogout}
              className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 hover:text-gray-900"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </main>
    </div>
  );
}
