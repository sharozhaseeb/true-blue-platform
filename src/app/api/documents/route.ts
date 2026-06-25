import { NextRequest } from "next/server";
import { getRequestContext } from "@/lib/tenant";
import { internalError, unauthorized } from "@/lib/errors";
import { prisma } from "@/lib/prisma";
import { DocumentStatus } from "@prisma/client";

/**
 * GET /api/documents
 *
 * List documents for the current tenant.
 * - Platform Admin sees all, can filter by ?firmId=
 * - Other roles always scoped to their own firmId
 * - Supports: ?status=COMPLETED, ?page=1&limit=20
 * - limit clamped to max 100
 */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getRequestContext();
    if (!ctx.isAuthenticated) {
      return unauthorized();
    }

    const { searchParams } = new URL(request.url);

    // Parse pagination
    let page = parseInt(searchParams.get("page") || "1", 10);
    if (isNaN(page) || page < 1) page = 1;

    let limit = parseInt(searchParams.get("limit") || "20", 10);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    const skip = (page - 1) * limit;

    // Build where clause
    const where: Record<string, any> = {};

    // Tenant scoping
    if (ctx.role === "PLATFORM_ADMIN") {
      // Platform Admin can filter by firmId, or see all
      const firmIdParam = searchParams.get("firmId");
      if (firmIdParam) {
        where.firmId = firmIdParam;
      }
    } else {
      // Non-admin: always scoped to own firm
      // ?firmId= parameter silently ignored for non-Platform-Admin
      if (!ctx.firmId) {
        return Response.json({ documents: [], total: 0, page, limit });
      }
      where.firmId = ctx.firmId;
    }

    // Optional status filter
    const statusParam = searchParams.get("status");
    if (
      statusParam &&
      ["UPLOADING", "PROCESSING", "COMPLETED", "FAILED"].includes(statusParam)
    ) {
      where.status = statusParam as DocumentStatus;
    }

    // Query documents
    const [documents, total] = await Promise.all([
      prisma.document.findMany({
        where,
        select: {
          id: true,
          filename: true,
          originalName: true,
          mimeType: true,
          fileSize: true,
          pageCount: true,
          status: true,
          errorMessage: true,
          firmId: true,
          uploadedById: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.document.count({ where }),
    ]);

    return Response.json({
      documents,
      total,
      page,
      limit,
    });
  } catch (err) {
    console.error("[documents] Failed to list documents");
    return internalError("Failed to list documents");
  }
}
