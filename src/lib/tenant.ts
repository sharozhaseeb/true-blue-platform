import { headers } from "next/headers";
import { Role } from "@prisma/client";

export interface RequestContext {
  userId: string;
  role: Role;
  firmId: string | null;
}

export async function getRequestContext(): Promise<RequestContext> {
  const headersList = await headers();
  const firmId = headersList.get("x-user-firm-id");
  return {
    userId: headersList.get("x-user-id") || "",
    role: (headersList.get("x-user-role") as Role) || "FIRM_USER",
    firmId: firmId || null,
  };
}

export function enforceTenantAccess(
  ctx: RequestContext,
  resourceFirmId: string
): boolean {
  if (ctx.role === "PLATFORM_ADMIN") return true;
  return ctx.firmId === resourceFirmId;
}
