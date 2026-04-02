import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import LandingPage from "./_components/landing-page";

export const metadata: Metadata = {
  title: "EulerTel — Financial Intelligence Platform",
  description:
    "Secure AI-powered document intelligence for tax professionals.",
  robots: { index: false, follow: false },
};

export default async function Home() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get("tb_access");

  if (accessToken) {
    redirect("/dashboard");
  }

  return <LandingPage />;
}
