import { NextRequest } from "next/server";
import { getRequestContext, enforceTenantAccess } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  notFound,
  forbidden,
  internalError,
  unauthorized,
  conflict,
} from "@/lib/errors";
import {
  deleteFromS3,
  deleteS3Prefix,
  getTextractResultsBucket,
} from "@/lib/s3";
import { prisma } from "@/lib/prisma";
import { normalizeChunkMetadata } from "@/lib/document-chunk-metadata";
import { readM3ProviderConfig } from "@/lib/ai/config";
import { PineconeVectorStore } from "@/lib/vector/pinecone";

interface RouteParams {
  params: Promise<{ id: string }>;
}

function parseVectorIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
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
    if (!ctx.isAuthenticated) {
      return unauthorized();
    }

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

    const normalizedChunks = chunks?.map((chunk) => ({
      ...chunk,
      metadata: normalizeChunkMetadata(chunk.metadata, chunk.pageNumber),
    }));

    return Response.json({
      document,
      ...(includeChunks
        ? {
            chunks: normalizedChunks,
            chunkTotal,
          }
        : {}),
    });
  } catch {
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
    if (!ctx.isAuthenticated) {
      return unauthorized();
    }

    const document = await prisma.document.findUnique({
      where: { id },
      select: {
        id: true,
        s3Key: true,
        s3Bucket: true,
        status: true,
        firmId: true,
        uploadedById: true,
        baseArtifacts: {
          select: {
            status: true,
            rawArtifactS3Key: true,
            normalizedArtifactS3Key: true,
          },
        },
        vectorIndexes: {
          select: {
            id: true,
            indexName: true,
            namespace: true,
            embeddingDim: true,
            vectorIds: true,
          },
        },
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

    // Delete external resources before DB mutation so a failed cleanup leaves
    // persisted document/index state intact for retry.
    const hasActiveArtifact = document.baseArtifacts.some((artifact) =>
      [
        "QUEUED",
        "STARTING_PROVIDER_JOB",
        "AWAITING_PROVIDER_RESULT",
        "PROVIDER_RESULT_READY",
        "NORMALIZING",
      ].includes(artifact.status)
    );
    if (
      document.status === "UPLOADING" ||
      document.status === "PROCESSING" ||
      hasActiveArtifact
    ) {
      return conflict("Document is still processing and cannot be deleted yet");
    }

    const vectorIndexesWithIds = document.vectorIndexes
      .map((index) => ({
        ...index,
        vectorIds: parseVectorIds(index.vectorIds),
      }))
      .filter((index) => index.vectorIds.length > 0);
    if (vectorIndexesWithIds.length > 0) {
      try {
        const config = readM3ProviderConfig();
        if (!config.pineconeApiKey) {
          throw new Error("PINECONE_API_KEY is required for vector cleanup");
        }

        for (const index of vectorIndexesWithIds) {
          const vectorStore = new PineconeVectorStore({
            apiKey: config.pineconeApiKey,
            indexName: index.indexName,
            namespace: index.namespace,
            dimension: index.embeddingDim,
          });
          await vectorStore.deleteVectorsByIds(index.vectorIds);
        }
      } catch (error) {
        console.error(`[documents] Vector delete failed for document ${id}`, error);
        return internalError("Failed to delete document vectors");
      }
    }

    const artifactKeys = document.baseArtifacts.flatMap((artifact) => [
      artifact.rawArtifactS3Key,
      artifact.normalizedArtifactS3Key,
    ]);
    if (artifactKeys.some(Boolean)) {
      try {
        await deleteDocumentArtifacts(artifactKeys, document.firmId, document.id);
      } catch (error) {
        console.error(`[documents] Artifact delete failed for document ${id}`, error);
        return internalError("Failed to delete document artifacts");
      }
    }

    if (document.s3Key) {
      try {
        await deleteFromS3(document.s3Bucket, document.s3Key);
      } catch (error) {
        console.error(`[documents] S3 delete failed for document ${id}`, error);
        return internalError("Failed to delete document from storage");
      }
    }

    // Delete DB row (cascade deletes chunks)
    await prisma.document.delete({
      where: { id },
    });

    return new Response(null, { status: 204 });
  } catch {
    console.error("[documents] Failed to delete document");
    return internalError("Failed to delete document");
  }
}

async function deleteDocumentArtifacts(
  keys: Array<string | null>,
  firmId: string,
  documentId: string
): Promise<void> {
  const bucket = getTextractResultsBucket();
  const uniqueKeys = [...new Set(keys.filter((key): key is string => Boolean(key)))];
  const expectedPrefix = `${firmId}/documents/${documentId}/base-artifacts/`;

  for (const key of uniqueKeys) {
    if (!key.startsWith(expectedPrefix)) {
      throw new Error(`Artifact key is outside document prefix: ${key}`);
    }

    if (key.endsWith("/")) {
      await deleteS3Prefix(bucket, key);
    } else {
      await deleteFromS3(bucket, key);
    }
  }
}
