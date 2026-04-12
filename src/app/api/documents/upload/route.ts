import { NextRequest } from "next/server";
import { getRequestContext } from "@/lib/tenant";
import { hasPermission } from "@/lib/rbac";
import {
  badRequest,
  forbidden,
  payloadTooLarge,
  unsupportedMediaType,
  tooManyRequests,
  internalError,
} from "@/lib/errors";
import {
  validatePdfUpload,
  validatePdfMagicBytes,
  sanitizeFilename,
} from "@/lib/validation";
import { uploadToS3, getS3Bucket, buildS3Key } from "@/lib/s3";
import { processDocument } from "@/lib/document-pipeline";
import { prisma } from "@/lib/prisma";

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// Concurrency semaphore — limits to 1 concurrent upload (staging has 2GB RAM)
let uploadInProgress = false;

export async function POST(request: NextRequest) {
  // Step 1: Early Content-Length check (before buffering)
  const contentLength = request.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
    return payloadTooLarge("File size exceeds maximum of 20MB");
  }

  // Step 2: Concurrency check
  if (uploadInProgress) {
    return tooManyRequests(
      "An upload is already in progress. Please try again shortly."
    );
  }

  uploadInProgress = true;

  try {
    // Step 3: Get request context
    const ctx = await getRequestContext();

    // Step 4: Permission check
    if (!hasPermission(ctx.role, "upload_documents")) {
      return forbidden("You do not have permission to upload documents");
    }

    // Step 5: Firm context required
    if (!ctx.firmId) {
      return badRequest("Upload requires a firm context");
    }

    // Step 6: Parse multipart form data
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return badRequest("Invalid form data");
    }

    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return badRequest("No file provided. Use the 'file' field.");
    }

    // Step 7: Defense-in-depth size check after buffering
    if (file.size > MAX_FILE_SIZE) {
      return payloadTooLarge("File size exceeds maximum of 20MB");
    }

    if (file.size === 0) {
      return badRequest("File is empty");
    }

    // Step 8: Validate extension and MIME type
    const validation = validatePdfUpload(file.name, file.type, file.size);
    if (!validation.valid) {
      return unsupportedMediaType(validation.error!);
    }

    // Step 9: Buffer file and validate magic bytes
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const magicValidation = validatePdfMagicBytes(buffer);
    if (!magicValidation.valid) {
      return unsupportedMediaType(magicValidation.error!);
    }

    // Step 10: Generate document ID, sanitize filename, build S3 key
    const sanitizedName = sanitizeFilename(file.name);
    const bucket = getS3Bucket();

    // Step 11: Create Document record (status: UPLOADING)
    const document = await prisma.document.create({
      data: {
        filename: sanitizedName,
        originalName: file.name,
        s3Key: "", // Set after we have the document ID
        s3Bucket: bucket,
        mimeType: "application/pdf",
        fileSize: file.size,
        status: "UPLOADING",
        firmId: ctx.firmId,
        uploadedById: ctx.userId,
      },
    });

    const s3Key = buildS3Key(ctx.firmId, document.id, sanitizedName);

    // Update the s3Key now that we have the document ID
    await prisma.document.update({
      where: { id: document.id },
      data: { s3Key },
    });

    try {
      // Step 12: Upload buffer to S3
      await uploadToS3(bucket, s3Key, buffer, "application/pdf");

      // Step 13: Update status to PROCESSING
      await prisma.document.update({
        where: { id: document.id },
        data: { status: "PROCESSING" },
      });

      // Step 14: Process document (extract, clean, chunk, store)
      const { pageCount, chunkCount } = await processDocument(
        document.id,
        buffer,
        sanitizedName
      );

      // Step 15: Return success
      return Response.json({
        document: {
          id: document.id,
          originalName: file.name,
          fileSize: file.size,
          pageCount,
          status: "COMPLETED",
          chunkCount,
        },
      });
    } catch {
      // Processing failed — document already marked FAILED by pipeline
      return internalError("Document processing failed");
    }
  } catch (err) {
    console.error("[upload] Unexpected error");
    return internalError("Upload failed");
  } finally {
    // Always release the semaphore
    uploadInProgress = false;
  }
}
