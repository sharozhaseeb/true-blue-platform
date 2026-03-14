import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyRefreshToken, getClearCookies } from "@/lib/auth";

export async function POST(request: NextRequest) {
  try {
    const refreshCookie = request.cookies.get("tb_refresh")?.value;

    if (refreshCookie) {
      try {
        const payload = await verifyRefreshToken(refreshCookie);
        await prisma.refreshToken.delete({
          where: { id: payload.tokenId },
        });
      } catch {
        // Token invalid — just clear cookies
      }
    }

    const response = NextResponse.json({ message: "Logged out" });
    getClearCookies().forEach((cookie) => {
      response.headers.append("Set-Cookie", cookie);
    });

    return response;
  } catch {
    // Even on error, clear cookies
    const response = NextResponse.json({ message: "Logged out" });
    getClearCookies().forEach((cookie) => {
      response.headers.append("Set-Cookie", cookie);
    });
    return response;
  }
}
