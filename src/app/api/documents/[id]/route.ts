import { NextRequest } from "next/server";
import { getRequestContext, enforceTenantAccess } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import { notFound, forbidden, internalError } from "@/lib/errors";
import { deleteFromS3 } from "@/lib/s3";
import { prisma } from "@/lib/prisma";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/documents/[id]
 *
 * Fetch document detail. Cross-tenant access returns 404.
 * Chunks are optional and paginated: ?chunks=true&page=1&limit=50
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getRequestContext();

    const document = await prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        filename: true,
        originalName: true,
        s3Key: true,
        s3Bucket: true,
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
    });

    if (!document) {
      return notFound("Document not found");
    }

    // Cross-tenant access returns 404 (not 403) to prevent ID enumeration
    if (!enforceTenantAccess(ctx, document.firmId)) {
      return notFound("Document not found");
    }

    const { searchParams } = new URL(request.url);
    const includeChunks = searchParams.get("chunks") === "true";

    let chunks = undefined;
    let chunkTotal = undefined;

    if (includeChunks) {
      let chunkPage = parseInt(searchParams.get("page") || "1", 10);
      if (isNaN(chunkPage) || chunkPage < 1) chunkPage = 1;

      let chunkLimit = parseInt(searchParams.get("limit") || "50", 10);
      if (isNaN(chunkLimit) || chunkLimit < 1) chunkLimit = 50;
      if (chunkLimit > 100) chunkLimit = 100;

      const chunkSkip = (chunkPage - 1) * chunkLimit;

      [chunks, chunkTotal] = await Promise.all([
        prisma.documentChunk.findMany({
          where: { documentId: id },
          select: {
            id: true,
            pageNumber: true,
            chunkIndex: true,
            content: true,
            tokenEstimate: true,
            metadata: true,
          },
          orderBy: { chunkIndex: "asc" },
          skip: chunkSkip,
          take: chunkLimit,
        }),
        prisma.documentChunk.count({ where: { documentId: id } }),
      ]);
    }

    return Response.json({
      document,
      ...(includeChunks
        ? {
            chunks,
            chunkTotal,
          }
        : {}),
    });
  } catch (err) {
    console.error("[documents] Failed to get document detail");
    return internalError("Failed to get document");
  }
}

/**
 * DELETE /api/documents/[id]
 *
 * Delete a document. S3 first, then DB.
 *
 * Authorization:
 * - Owner can delete their own documents
 * - FIRM_ADMIN can delete any document in their firm
 * - PLATFORM_ADMIN can delete any document
 * - FIRM_USER who is not the owner gets 403
 *
 * Cross-tenant access returns 404.
 */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const ctx = await getRequestContext();

    const document = await prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        s3Key: true,
        s3Bucket: true,
        firmId: true,
        uploadedById: true,
      },
    });

    if (!document) {
      return notFound("Document not found");
    }

    // Cross-tenant access returns 404
    if (!enforceTenantAccess(ctx, document.firmId)) {
      return notFound("Document not found");
    }

    // Authorization check
    const isOwner = document.uploadedById === ctx.userId;
    const canDelete = hasPermission(ctx.role, "delete_documents");

    if (!isOwner && !canDelete) {
      return forbidden("You do not have permission to delete this document");
    }

    // Delete order: S3 first, then DB
    // If S3 fails, return error — DB row intact, user can retry
    if (document.s3Key) {
      try {
        await deleteFromS3(document.s3Bucket, document.s3Key);
      } catch (err) {
        console.error(`[documents] S3 delete failed for document ${id}`);
        return internalError("Failed to delete document from storage");
      }
    }

    // Delete DB row (cascade deletes chunks)
    await prisma.document.delete({
      where: { id },
    });

    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("[documents] Failed to delete document");
    return internalError("Failed to delete document");
  }
}
