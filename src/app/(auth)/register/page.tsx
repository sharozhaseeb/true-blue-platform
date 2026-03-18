"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export default function RegisterPage() {
  const router = useRouter();
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    password: "",
    firmSlug: "",
  });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  function updateField(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
        credentials: "include",
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.message || "Registration failed");
        return;
      }

      router.push("/dashboard");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-lg rounded-2xl bg-white/85 p-10 sm:p-12 shadow-[0_4px_6px_-1px_rgba(0,0,0,0.05),0_20px_50px_-12px_rgba(0,0,0,0.25)] border border-white/20 backdrop-blur-xl">
      <Link href="/" className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 transition-colors mb-8">
        <ArrowLeft className="h-3 w-3" />
        Home
      </Link>
      <div className="text-center mb-10">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-blue-600 shadow-md">
          <span className="text-lg font-bold text-white tracking-tight">
            TB
          </span>
        </div>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">
          True Blue
        </h1>
        <p className="mt-2 text-sm font-medium tracking-wide text-gray-400 uppercase">
          Create your account
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div className="rounded-lg bg-red-50/80 border border-red-100 px-4 py-3 text-sm text-red-600">
            {error}
          </div>
        )}

        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <div>
              <label
                htmlFor="firstName"
                className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2"
              >
                First name
              </label>
              <input
                id="firstName"
                type="text"
                required
                value={form.firstName}
                onChange={(e) => updateField("firstName", e.target.value)}
                className="block w-full h-12 rounded-lg border border-gray-200/60 bg-white/80 px-4 py-3 text-base text-gray-900 placeholder-gray-300 transition-colors duration-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:bg-white"
              />
            </div>
            <div>
              <label
                htmlFor="lastName"
                className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2"
              >
                Last name
              </label>
              <input
                id="lastName"
                type="text"
                required
                value={form.lastName}
                onChange={(e) => updateField("lastName", e.target.value)}
                className="block w-full h-12 rounded-lg border border-gray-200/60 bg-white/80 px-4 py-3 text-base text-gray-900 placeholder-gray-300 transition-colors duration-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:bg-white"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="email"
              className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2"
            >
              Email
            </label>
            <input
              id="email"
              type="email"
              required
              value={form.email}
              onChange={(e) => updateField("email", e.target.value)}
              className="block w-full h-12 rounded-lg border border-gray-200/60 bg-white/80 px-4 py-3 text-base text-gray-900 placeholder-gray-300 transition-colors duration-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:bg-white"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              required
              value={form.password}
              onChange={(e) => updateField("password", e.target.value)}
              className="block w-full h-12 rounded-lg border border-gray-200/60 bg-white/80 px-4 py-3 text-base text-gray-900 placeholder-gray-300 transition-colors duration-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:bg-white"
              placeholder="Min 8 chars, uppercase, lowercase, number"
            />
            <p className="mt-1.5 text-xs text-gray-400/80">
              At least 8 characters with uppercase, lowercase, and a number
            </p>
          </div>

          <div>
            <label
              htmlFor="firmSlug"
              className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2"
            >
              Firm code
            </label>
            <input
              id="firmSlug"
              type="text"
              required
              value={form.firmSlug}
              onChange={(e) => updateField("firmSlug", e.target.value)}
              className="block w-full h-12 rounded-lg border border-gray-200/60 bg-white/80 px-4 py-3 text-base text-gray-900 placeholder-gray-300 transition-colors duration-200 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:bg-white"
              placeholder="Provided by your firm admin"
            />
            <p className="mt-1.5 text-xs text-gray-400/80">
              Enter the firm code provided by your administrator
            </p>
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full h-12 rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 py-3 text-base font-semibold text-white shadow-md shadow-blue-600/25 transition-all duration-200 hover:from-blue-600 hover:to-blue-700 hover:shadow-lg hover:shadow-blue-600/30 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 active:from-blue-700 active:to-blue-800 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
        >
          {loading ? "Creating account..." : "Create account"}
        </button>

        <p className="text-center text-sm text-gray-400 pt-2">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-blue-600 hover:text-blue-500"
          >
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
