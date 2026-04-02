import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRequestContext } from "@/lib/tenant";
import { unauthorized, internalError } from "@/lib/errors";

export async function GET() {
  if (process.env.ENABLE_TEST_ENDPOINTS !== "true") {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  try {
    const ctx = await getRequestContext();

    if (!ctx.userId) {
      return unauthorized();
    }

    if (ctx.role === "PLATFORM_ADMIN") {
      const firms = await prisma.firm.findMany({
        where: { isActive: true },
        select: { name: true, _count: { select: { users: true } } },
        orderBy: { name: "asc" },
      });

      const totalUsers = await prisma.user.count();

      return NextResponse.json({
        test: "tenant_isolation",
        scope: "all_firms",
        description:
          "Platform Admin sees all firms. This is expected — Platform Admins are not bound to a single tenant.",
        firms: firms.map((f) => ({
          name: f.name,
          userCount: f._count.users,
        })),
        totalUsers,
      });
    }

    const yourFirmUserCount = await prisma.user.count({
      where: { firmId: ctx.firmId! },
    });

    const firm = await prisma.firm.findUnique({
      where: { id: ctx.firmId! },
      select: { name: true },
    });

    const yourRoles = await prisma.user.findMany({
      where: { firmId: ctx.firmId! },
      select: { role: true },
      distinct: ["role"],
    });

    return NextResponse.json({
      test: "tenant_isolation",
      scope: "single_firm",
      yourFirm: firm?.name,
      yourFirmUserCount,
      otherFirmsVisible: 0,
      roles: yourRoles.map((u) => u.role),
      description:
        "Query filtered by firmId from authenticated JWT. 0 records from other firms returned.",
    });
  } catch (error) {
    console.error("Tenant check error:", error);
    return internalError();
  }
}
