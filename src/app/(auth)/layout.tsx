"use client";

import { BackgroundGradientAnimation } from "@/components/ui/background-gradient-animation";

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
      <div className="absolute inset-0 z-10 flex flex-col min-h-screen">
        <main className="flex flex-1 items-center justify-center px-4">
          {children}
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
