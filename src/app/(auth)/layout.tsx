"use client";

import { BackgroundGradientAnimation } from "@/components/ui/background-gradient-animation";
import { ShieldCheck, Server, FileText, Brain, Building2 } from "lucide-react";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
      <div className="absolute inset-0 z-10 flex min-h-screen">
        {/* Left — Brand content floating on the gradient (desktop only) */}
        <div className="hidden lg:flex lg:w-[45%] flex-col p-12 xl:p-16">
          {/* Top: Logo */}
          <div className="mb-auto">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-white/10 backdrop-blur-sm border border-white/10 flex items-center justify-center">
                <span className="text-sm font-bold text-white">TB</span>
              </div>
              <span className="text-lg font-semibold text-white/90">
                True Blue
              </span>
            </div>
          </div>

          {/* Middle: Tagline + features */}
          <div className="mb-auto">
            <h2 className="text-3xl xl:text-4xl font-bold text-white leading-tight mb-4">
              Financial intelligence,
              <br />
              built for tax professionals.
            </h2>
            <p className="text-base text-white/40 max-w-sm leading-relaxed mb-12">
              Secure document analysis powered by AI. Trusted by firms
              nationwide.
            </p>

            {/* Feature list */}
            <div className="space-y-5 max-w-xs">
              <div className="flex items-center gap-3">
                <FileText className="h-4 w-4 text-blue-400/70 shrink-0" />
                <span className="text-sm text-white/50">
                  Secure document analysis
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Brain className="h-4 w-4 text-blue-400/70 shrink-0" />
                <span className="text-sm text-white/50">
                  AI-powered insights with citations
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Building2 className="h-4 w-4 text-blue-400/70 shrink-0" />
                <span className="text-sm text-white/50">
                  Multi-firm role-based isolation
                </span>
              </div>
            </div>
          </div>

          {/* Bottom: Trust indicators */}
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-white/25">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span className="text-[11px] font-medium tracking-wider uppercase">
                256-bit Encryption
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Server className="h-3.5 w-3.5" />
              <span className="text-[11px] font-medium tracking-wider uppercase">
                Tenant Isolated
              </span>
            </div>
          </div>
        </div>

        {/* Right — Floating form card */}
        <div className="flex-1 lg:flex-none lg:w-[44%] flex flex-col my-4 mr-4 lg:my-5 lg:mr-5 rounded-2xl lg:rounded-3xl bg-blue-50/90 backdrop-blur-xl shadow-[0_8px_32px_-8px_rgba(0,0,0,0.3)] border border-blue-100/40">
          {/* Mobile-only header */}
          <div className="lg:hidden px-6 pt-6">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-lg bg-blue-600 flex items-center justify-center">
                <span className="text-sm font-bold text-white">TB</span>
              </div>
              <span className="text-base font-semibold text-gray-900">
                True Blue
              </span>
            </div>
          </div>

          {/* Form content area */}
          <main className="flex flex-1 items-center justify-center px-6 py-12 sm:px-8 lg:px-12 xl:px-16">
            <div className="w-full max-w-md lg:max-w-lg">{children}</div>
          </main>

          {/* Footer */}
          <footer className="px-6 py-4">
            <p className="text-center text-xs text-gray-400">
              &copy; 2026 True Blue Financial Intelligence LLC
            </p>
          </footer>
        </div>
      </div>
    </BackgroundGradientAnimation>
  );
}
