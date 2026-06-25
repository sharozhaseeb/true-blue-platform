import { NextRequest } from "next/server";
import { ChatThreadStatus } from "@prisma/client";
import { hasPermission } from "@/lib/rbac";
import { internalError, forbidden, unauthorized } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { getFirmScopedRequestContext } from "@/lib/tenant";

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;

function parseLimit(value: string | null): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_LIMIT;
  }

  return Math.min(parsed, MAX_LIMIT);
}

function parseCursor(value: string | null): { updatedAt: Date; id: string } | null {
  if (!value) {
    return null;
  }

  const [updatedAtValue, id] = Buffer.from(value, "base64url")
    .toString("utf8")
    .split("|");
  const updatedAt = new Date(updatedAtValue);
  if (!id || Number.isNaN(updatedAt.getTime())) {
    return null;
  }

  return { updatedAt, id };
}

function createCursor(input: { updatedAt: Date; id: string }): string {
  return Buffer.from(`${input.updatedAt.toISOString()}|${input.id}`).toString(
    "base64url"
  );
}

function sourceCount(documentFilter: unknown): number | null {
  if (
    typeof documentFilter !== "object" ||
    documentFilter === null ||
    !("documentIds" in documentFilter)
  ) {
    return null;
  }

  const documentIds = (documentFilter as { documentIds?: unknown }).documentIds;
  return Array.isArray(documentIds) ? documentIds.length : 0;
}

export async function GET(request: NextRequest) {
  try {
    const ctx = await getFirmScopedRequestContext();
    if (!ctx) {
      return unauthorized();
    }

    if (!hasPermission(ctx.role, "query_documents")) {
      return forbidden("You do not have permission to query documents");
    }

    const { searchParams } = new URL(request.url);
    const limit = parseLimit(searchParams.get("limit"));
    const cursor = parseCursor(searchParams.get("cursor"));
    const threads = await prisma.chatThread.findMany({
      where: {
        firmId: ctx.firmId,
        userId: ctx.userId,
        status: ChatThreadStatus.ACTIVE,
        ...(cursor
          ? {
              OR: [
                { updatedAt: { lt: cursor.updatedAt } },
                { updatedAt: cursor.updatedAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        title: true,
        documentFilter: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { messages: true },
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const visibleThreads = threads.slice(0, limit);
    const nextThread = threads.length > limit ? visibleThreads.at(-1) : null;

    return Response.json({
      threads: visibleThreads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        documentFilter: thread.documentFilter,
        sourceCount: sourceCount(thread.documentFilter),
        messageCount: thread._count.messages,
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
      })),
      nextCursor: nextThread
        ? createCursor({ id: nextThread.id, updatedAt: nextThread.updatedAt })
        : null,
    });
  } catch (error) {
    console.error("[chat:threads] Failed to list threads", error);
    return internalError("Failed to list chat threads");
  }
}
