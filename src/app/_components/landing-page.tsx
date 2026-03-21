"use client";

import Link from "next/link";
import { Check, Shield, Server } from "lucide-react";
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
          <div className="animate-fade-in-up w-full max-w-md rounded-2xl bg-white/85 shadow-[0_8px_16px_-4px_rgba(0,0,0,0.08),0_24px_60px_-16px_rgba(0,0,0,0.3)] border border-white/30 backdrop-blur-xl">
            <div className="p-10 sm:p-12">
              {/* Brand */}
              <div className="text-center mb-12 animate-fade-in-up [animation-delay:100ms]">
                <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-xl bg-blue-600 shadow-lg shadow-blue-600/20">
                  <span className="text-xl font-bold text-white tracking-tight">
                    TB
                  </span>
                </div>
                <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-gray-900">
                  True Blue
                </h1>
                <p className="mt-3 text-xs font-semibold tracking-[0.25em] text-gray-400 uppercase">
                  Financial Intelligence Platform
                </p>
              </div>

              {/* Value propositions */}
              <ul className="mb-10 space-y-4 animate-fade-in-up [animation-delay:200ms]">
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100">
                    <Check className="h-3 w-3 text-blue-600 stroke-[3]" />
                  </span>
                  <span className="text-[0.9375rem] text-gray-600">
                    Secure document analysis for tax firms
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100">
                    <Check className="h-3 w-3 text-blue-600 stroke-[3]" />
                  </span>
                  <span className="text-[0.9375rem] text-gray-600">
                    AI-powered insights with source citations
                  </span>
                </li>
                <li className="flex items-start gap-3">
                  <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-100">
                    <Check className="h-3 w-3 text-blue-600 stroke-[3]" />
                  </span>
                  <span className="text-[0.9375rem] text-gray-600">
                    Multi-firm isolation with role-based access
                  </span>
                </li>
              </ul>

              {/* CTAs */}
              <div className="space-y-3 animate-fade-in-up [animation-delay:300ms]">
                <Link
                  href="/login"
                  className="flex w-full h-12 items-center justify-center rounded-lg bg-gradient-to-b from-blue-500 to-blue-600 px-4 text-base font-semibold text-white shadow-md shadow-blue-600/25 transition-all duration-200 hover:from-blue-600 hover:to-blue-700 hover:shadow-lg hover:shadow-blue-600/30 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 active:scale-[0.98] active:from-blue-700 active:to-blue-800 cursor-pointer"
                >
                  Sign in
                </Link>
                <Link
                  href="/register"
                  className="flex w-full h-12 items-center justify-center rounded-lg border border-gray-200/60 bg-white/50 px-4 text-base font-semibold text-gray-600 transition-all duration-200 hover:bg-white hover:border-gray-300 hover:text-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 active:scale-[0.98] cursor-pointer"
                >
                  Register
                </Link>
              </div>

              {/* Trust bar */}
              <div className="mt-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-gray-400 animate-fade-in [animation-delay:400ms]">
                <div className="flex items-center gap-1.5">
                  <Shield className="h-3.5 w-3.5" />
                  <span className="text-[10px] font-medium uppercase tracking-wider">
                    256-bit Encryption
                  </span>
                </div>
                <div className="hidden sm:block h-3 w-px bg-gray-200/60" />
                <div className="flex items-center gap-1.5">
                  <Server className="h-3.5 w-3.5" />
                  <span className="text-[10px] font-medium uppercase tracking-wider">
                    Multi-tenant Isolation
                  </span>
                </div>
              </div>

              {/* Help text */}
              <div className="mt-6 space-y-1.5 animate-fade-in [animation-delay:500ms]">
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
