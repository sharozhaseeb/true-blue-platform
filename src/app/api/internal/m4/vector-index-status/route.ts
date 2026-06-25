import { NextRequest } from "next/server";
import { hasPermission } from "@/lib/rbac";
import { badRequest, forbidden, notFound, unauthorized } from "@/lib/errors";
import { getFirmScopedRequestContext } from "@/lib/tenant";
import { prisma } from "@/lib/prisma";

function jsonArrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export async function GET(request: NextRequest) {
  const ctx = await getFirmScopedRequestContext();
  if (!ctx) {
    return unauthorized();
  }

  if (!hasPermission(ctx.role, "query_documents")) {
    return forbidden("You do not have permission to inspect vector readiness");
  }

  const { searchParams } = new URL(request.url);
  const documentId = searchParams.get("documentId")?.trim();
  if (!documentId) {
    return badRequest("documentId is required");
  }

  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      firmId: ctx.firmId,
    },
    select: {
      id: true,
      status: true,
      vectorIndexes: {
        select: {
          indexName: true,
          namespace: true,
          embeddingModel: true,
          embeddingDim: true,
          parserVersion: true,
          chunkStrategy: true,
          generation: true,
          isActive: true,
          status: true,
          vectorIds: true,
          chunkIds: true,
          updatedAt: true,
        },
        orderBy: [{ isActive: "desc" }, { generation: "desc" }],
      },
    },
  });

  if (!document) {
    return notFound("Document not found");
  }

  const indexes = document.vectorIndexes.map((index) => ({
    indexName: index.indexName,
    namespace: index.namespace,
    embeddingModel: index.embeddingModel,
    embeddingDim: index.embeddingDim,
    parserVersion: index.parserVersion,
    chunkStrategy: index.chunkStrategy,
    generation: index.generation,
    isActive: index.isActive,
    status: index.status,
    vectorIdCount: jsonArrayLength(index.vectorIds),
    chunkIdCount: jsonArrayLength(index.chunkIds),
    updatedAt: index.updatedAt.toISOString(),
  }));
  const activeIndex = indexes.find(
    (index) => index.isActive && index.status === "ACTIVE"
  );

  return Response.json({
    documentId: document.id,
    documentStatus: document.status,
    checkedAt: new Date().toISOString(),
    isActive: Boolean(activeIndex),
    status: activeIndex?.status ?? "UNAVAILABLE",
    index: activeIndex ?? null,
    indexes,
  });
}
