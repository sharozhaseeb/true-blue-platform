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

  const inputClasses =
    "block w-full h-12 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 text-base text-gray-900 placeholder-gray-300 transition-all duration-200 hover:border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:bg-white focus:shadow-[0_0_0_3px_rgba(59,130,246,0.08)]";

  return (
    <>
      <div className="animate-fade-in">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600 transition-colors duration-200 mb-10"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Home
        </Link>
      </div>

      <div className="animate-fade-in-up mb-10">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">
          Create your account
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          Get started with True Blue in minutes
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {error && (
          <div
            role="alert"
            className="animate-fade-in rounded-lg bg-red-50/80 border border-red-100 px-4 py-3 text-sm text-red-600"
          >
            {error}
          </div>
        )}

        <div className="space-y-5 animate-fade-in-up [animation-delay:100ms]">
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
                className={inputClasses}
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
                className={inputClasses}
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
              className={inputClasses}
              placeholder="you@example.com"
            />
          </div>
        </div>

        <div className="space-y-5 animate-fade-in-up [animation-delay:200ms]">
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
              className={inputClasses}
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
              className={inputClasses}
              placeholder="Provided by your firm admin"
            />
            <p className="mt-1.5 text-xs text-gray-400/80">
              Enter the firm code provided by your administrator
            </p>
          </div>
        </div>

        <div className="animate-fade-in-up [animation-delay:300ms]">
          <button
            type="submit"
            disabled={loading}
            className="w-full h-12 rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 py-3 text-base font-semibold text-white shadow-md shadow-blue-600/25 transition-all duration-200 hover:from-blue-600 hover:to-blue-700 hover:shadow-lg hover:shadow-blue-600/30 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 active:scale-[0.98] active:from-blue-700 active:to-blue-800 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none cursor-pointer"
          >
            {loading ? "Creating account..." : "Create account"}
          </button>
        </div>

        <p className="text-center text-sm text-gray-400 pt-4 animate-fade-in [animation-delay:400ms]">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-blue-600 hover:text-blue-500 transition-colors"
          >
            Sign in
          </Link>
        </p>
      </form>
    </>
  );
}
