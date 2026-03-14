"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthUser } from "@/types";

const ROLE_LABELS: Record<string, string> = {
  PLATFORM_ADMIN: "Platform Admin",
  FIRM_ADMIN: "Firm Admin",
  FIRM_USER: "Firm User",
};

const ROLE_COLORS: Record<string, string> = {
  PLATFORM_ADMIN: "bg-purple-100 text-purple-800",
  FIRM_ADMIN: "bg-blue-100 text-blue-800",
  FIRM_USER: "bg-green-100 text-green-800",
};

export default function DashboardPage() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchUser() {
      try {
        const res = await fetch("/api/auth/me", { credentials: "include" });

        if (!res.ok) {
          router.push("/login");
          return;
        }

        const data = await res.json();
        setUser(data.user);
      } catch {
        router.push("/login");
      } finally {
        setLoading(false);
      }
    }

    fetchUser();
  }, [router]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500">Loading...</p>
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">
          Welcome, {user.firstName}
        </h2>
        <p className="mt-1 text-sm text-gray-500">
          Here&apos;s your account overview
        </p>
      </div>

      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-sm font-medium text-gray-500">Name</dt>
            <dd className="mt-1 text-sm text-gray-900">
              {user.firstName} {user.lastName}
            </dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Email</dt>
            <dd className="mt-1 text-sm text-gray-900">{user.email}</dd>
          </div>
          <div>
            <dt className="text-sm font-medium text-gray-500">Role</dt>
            <dd className="mt-1">
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_COLORS[user.role] || "bg-gray-100 text-gray-800"}`}
              >
                {ROLE_LABELS[user.role] || user.role}
              </span>
            </dd>
          </div>
          {user.firmName && (
            <div>
              <dt className="text-sm font-medium text-gray-500">Firm</dt>
              <dd className="mt-1 text-sm text-gray-900">{user.firmName}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>
  );
}
