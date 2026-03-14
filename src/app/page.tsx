import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export default async function Home() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get("tb_access");

  if (accessToken) {
    redirect("/dashboard");
  } else {
    redirect("/login");
  }
}
