import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRequestContext } from "@/lib/tenant";
import { hasPermission, type Permission } from "@/lib/rbac";
import { Role } from "@prisma/client";
import { unauthorized, internalError } from "@/lib/errors";

const ALL_PERMISSIONS: Permission[] = [
  "manage_firms",
  "manage_all_users",
  "manage_firm_users",
  "view_firm_data",
  "upload_documents",
  "query_documents",
];

export async function GET() {
  if (process.env.ENABLE_TEST_ENDPOINTS !== "true") {
    return NextResponse.json({ error: "Not Found" }, { status: 404 });
  }

  try {
    const ctx = await getRequestContext();

    if (!ctx.userId) {
      return unauthorized();
    }

    const role = ctx.role as Role;
    const granted = ALL_PERMISSIONS.filter((p) => hasPermission(role, p));
    const denied = ALL_PERMISSIONS.filter((p) => !hasPermission(role, p));

    if (ctx.role === "PLATFORM_ADMIN") {
      const firmCount = await prisma.firm.count({ where: { isActive: true } });
      const totalUserCount = await prisma.user.count();

      return NextResponse.json({
        test: "rbac",
        role: ctx.role,
        permissions: { granted, denied },
        description:
          "Platform Admin has full access to all firms and all operations.",
        dataScope: "all_firms",
        firmCount,
        totalUserCount,
      });
    }

    if (ctx.role === "FIRM_ADMIN") {
      const firmUserCount = await prisma.user.count({
        where: { firmId: ctx.firmId! },
      });

      return NextResponse.json({
        test: "rbac",
        role: ctx.role,
        permissions: { granted, denied },
        description:
          "Firm Admin can manage users within their firm but cannot manage other firms or platform-wide settings.",
        dataScope: "own_firm",
        firmUserCount,
      });
    }

    return NextResponse.json({
      test: "rbac",
      role: ctx.role,
      permissions: { granted, denied },
      description:
        "Firm User can view data, upload documents, and query within their firm. Cannot manage users or firms.",
      dataScope: "own_profile_only",
    });
  } catch (error) {
    console.error("RBAC check error:", error);
    return internalError();
  }
}
