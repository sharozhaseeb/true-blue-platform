import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyAccessToken } from "@/lib/auth";

const PUBLIC_PATHS = [
  "/login",
  "/register",
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/refresh",
];

const ADMIN_ONLY_PATHS = ["/api/admin"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets and Next.js internals
  if (pathname.startsWith("/_next") || pathname.startsWith("/favicon")) {
    return NextResponse.next();
  }

  const accessToken = request.cookies.get("tb_access")?.value;

  if (!accessToken) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  try {
    const payload = await verifyAccessToken(accessToken);

    // RBAC: Admin-only paths
    if (ADMIN_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
      if (payload.role !== "PLATFORM_ADMIN") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    // Inject user context into request headers for API routes
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("x-user-id", payload.userId);
    requestHeaders.set("x-user-role", payload.role);
    requestHeaders.set("x-user-firm-id", payload.firmId || "");

    return NextResponse.next({
      request: { headers: requestHeaders },
    });
  } catch {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Token expired" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
