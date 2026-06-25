import { Role } from "@prisma/client";
import { cookies } from "next/headers";
import { verifyAccessToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export interface AuthenticatedRequestContext {
  userId: string;
  role: Role;
  firmId: string | null;
  isAuthenticated: true;
}

export interface AnonymousRequestContext {
  userId: "";
  role: null;
  firmId: null;
  isAuthenticated: false;
}

export type RequestContext = AuthenticatedRequestContext | AnonymousRequestContext;

export type FirmScopedRequestContext = AuthenticatedRequestContext & {
  firmId: string;
};

type TenantContextDb = {
  user: {
    findUnique(args: {
      where: { id: string };
      select: {
        id: true;
        role: true;
        firmId: true;
        isActive: true;
        firm: {
          select: {
            id: true;
            isActive: true;
          };
        };
      };
    }): Promise<{
      id: string;
      role: Role;
      firmId: string | null;
      isActive: boolean;
      firm: { id: string; isActive: boolean } | null;
    } | null>;
  };
};

const ANONYMOUS_REQUEST_CONTEXT: RequestContext = {
  userId: "",
  role: null,
  firmId: null,
  isAuthenticated: false,
};

function isInvalidTokenError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  if (error.message.startsWith("Missing required environment variable:")) {
    return false;
  }

  return true;
}

export async function resolveRequestContextFromAccessToken(
  accessToken: string | undefined,
  db: TenantContextDb = prisma
): Promise<RequestContext> {
  if (!accessToken) {
    return ANONYMOUS_REQUEST_CONTEXT;
  }

  let payload;
  try {
    payload = await verifyAccessToken(accessToken);
  } catch (error) {
    if (!isInvalidTokenError(error)) {
      throw error;
    }

    return ANONYMOUS_REQUEST_CONTEXT;
  }

  const user = await db.user.findUnique({
    where: { id: payload.userId },
    select: {
      id: true,
      role: true,
      firmId: true,
      isActive: true,
      firm: {
        select: {
          id: true,
          isActive: true,
        },
      },
    },
  });

  if (!user || !user.isActive) {
    return ANONYMOUS_REQUEST_CONTEXT;
  }

  if (user.role === "PLATFORM_ADMIN" && user.firmId !== null) {
    return ANONYMOUS_REQUEST_CONTEXT;
  }

  if (user.role !== "PLATFORM_ADMIN" && (!user.firmId || !user.firm?.isActive)) {
    return ANONYMOUS_REQUEST_CONTEXT;
  }

  return {
    userId: user.id,
    role: user.role,
    firmId: user.firmId,
    isAuthenticated: true,
  };
}

export async function getRequestContext(): Promise<RequestContext> {
  const cookieStore = await cookies();
  return {
    ...(await resolveRequestContextFromAccessToken(
      cookieStore.get("tb_access")?.value
    )),
  };
}

export function enforceTenantAccess(
  ctx: RequestContext,
  resourceFirmId: string
): boolean {
  if (!ctx.isAuthenticated) return false;
  if (ctx.role === "PLATFORM_ADMIN") return true;
  return ctx.firmId === resourceFirmId;
}

export async function getAuthenticatedRequestContext(): Promise<AuthenticatedRequestContext | null> {
  const ctx = await getRequestContext();
  return ctx.isAuthenticated ? ctx : null;
}

export async function getFirmScopedRequestContext(): Promise<FirmScopedRequestContext | null> {
  const ctx = await getAuthenticatedRequestContext();
  if (!ctx || ctx.role === "PLATFORM_ADMIN" || !ctx.firmId) {
    return null;
  }

  return ctx as FirmScopedRequestContext;
}
