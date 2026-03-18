"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { BackgroundGradientAnimation } from "@/components/ui/background-gradient-animation";

export default function LandingPage() {
  return (
    <BackgroundGradientAnimation
      gradientBackgroundStart="rgb(15, 23, 42)"
      gradientBackgroundEnd="rgb(22, 33, 55)"
      firstColor="45, 70, 110"
      secondColor="55, 75, 115"
      thirdColor="65, 85, 120"
      fourthColor="50, 72, 108"
      fifthColor="58, 80, 118"
      pointerColor="55, 78, 115"
      containerClassName="!h-screen"
    >
      <div className="absolute inset-0 z-10 flex flex-col min-h-screen">
        <main className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-md rounded-2xl bg-white/85 p-10 sm:p-12 shadow-[0_4px_6px_-1px_rgba(0,0,0,0.05),0_20px_50px_-12px_rgba(0,0,0,0.25)] border border-white/20 backdrop-blur-xl">
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
                Financial Intelligence Platform
              </p>
            </div>

            <ul className="mb-8 space-y-3">
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100"><Check className="h-3 w-3 text-blue-600 stroke-[3]" /></span>
                <span className="text-sm text-gray-600">Secure document analysis for tax firms</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100"><Check className="h-3 w-3 text-blue-600 stroke-[3]" /></span>
                <span className="text-sm text-gray-600">AI-powered insights with source citations</span>
              </li>
              <li className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100"><Check className="h-3 w-3 text-blue-600 stroke-[3]" /></span>
                <span className="text-sm text-gray-600">Multi-firm isolation with role-based access</span>
              </li>
            </ul>

            <div className="space-y-3">
              <Link
                href="/login"
                className="flex w-full h-12 items-center justify-center rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 text-base font-semibold text-white shadow-md shadow-blue-600/25 transition-all duration-200 hover:from-blue-600 hover:to-blue-700 hover:shadow-lg hover:shadow-blue-600/30 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 active:from-blue-700 active:to-blue-800"
              >
                Sign in
              </Link>
              <Link
                href="/register"
                className="flex w-full h-12 items-center justify-center rounded-lg border border-gray-200/60 bg-white/50 px-4 text-base font-semibold text-gray-600 transition-all duration-200 hover:bg-white hover:border-gray-300 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                Register
              </Link>
            </div>

            <div className="mt-8 space-y-2">
              <p className="text-center text-xs text-gray-400">
                Platform access is available to authorized firms.
              </p>
              <p className="text-center text-xs text-gray-400">
                Need help?{" "}
                <a
                  href="mailto:support@truebluefinancial.com"
                  className="text-blue-500 hover:text-blue-600 transition-colors"
                >
                  Contact support
                </a>
              </p>
            </div>
          </div>
        </main>

        <footer className="px-6 py-4">
          <p className="text-center text-xs text-white/25">
            &copy; 2026 True Blue Financial Intelligence LLC
          </p>
        </footer>
      </div>
    </BackgroundGradientAnimation>
  );
}
