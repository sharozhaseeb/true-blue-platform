import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

// Lazy-initialized S3 client — avoids module-level evaluation during Next.js build
let _s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!_s3Client) {
    const region = process.env.AWS_REGION;
    if (!region) {
      throw new Error("Missing required environment variable: AWS_REGION");
    }
    // EC2 uses IAM Instance Profile — no explicit credentials needed.
    // Local dev uses AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY from environment.
    _s3Client = new S3Client({ region });
  }
  return _s3Client;
}

export function getS3Bucket(): string {
  const bucket = process.env.AWS_S3_BUCKET;
  if (!bucket) {
    throw new Error("Missing required environment variable: AWS_S3_BUCKET");
  }
  return bucket;
}

export function getTextractResultsBucket(): string {
  const bucket = process.env.TEXTRACT_RESULTS_BUCKET;
  if (!bucket) {
    throw new Error("Missing required environment variable: TEXTRACT_RESULTS_BUCKET");
  }
  return bucket;
}

function getS3KmsKeyId(): string | undefined {
  const keyId = process.env.AWS_S3_KMS_KEY_ID;
  return keyId && keyId.trim().length > 0 ? keyId : undefined;
}

/**
 * Build the S3 key for a document.
 * Structure: {firmId}/documents/{documentId}/{filename}
 */
export function buildS3Key(
  firmId: string,
  documentId: string,
  filename: string
): string {
  return `${firmId}/documents/${documentId}/${filename}`;
}

/**
 * Upload a buffer to S3. In staging/prod, AWS_S3_KMS_KEY_ID should be set so
 * tax PDFs are explicitly encrypted with the customer-managed KMS key.
 */
export async function uploadToS3(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  const client = getS3Client();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      ...(getS3KmsKeyId()
        ? {
            ServerSideEncryption: "aws:kms" as const,
            SSEKMSKeyId: getS3KmsKeyId(),
          }
        : {}),
    })
  );
}

export async function uploadJsonToS3(
  bucket: string,
  key: string,
  body: unknown
): Promise<void> {
  await uploadToS3(
    bucket,
    key,
    Buffer.from(JSON.stringify(body, null, 2)),
    "application/json"
  );
}

/**
 * Delete an object from S3.
 */
export async function deleteFromS3(
  bucket: string,
  key: string
): Promise<void> {
  const client = getS3Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    })
  );
}

export async function deleteS3Prefix(
  bucket: string,
  prefix: string
): Promise<number> {
  const client = getS3Client();
  let continuationToken: string | undefined;
  let deleted = 0;

  do {
    const listed = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      })
    );

    const objects = (listed.Contents ?? [])
      .map((object) => object.Key)
      .filter((key): key is string => Boolean(key));

    if (objects.length > 0) {
      const result = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: objects.map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      );
      if (result.Errors && result.Errors.length > 0) {
        const failedKeys = result.Errors
          .map((error) => error.Key)
          .filter(Boolean)
          .join(", ");
        throw new Error(
          `Failed to delete ${result.Errors.length} S3 object(s) under ${prefix}: ${failedKeys}`
        );
      }
      deleted += objects.length;
    }

    continuationToken = listed.NextContinuationToken;
  } while (continuationToken);

  return deleted;
}
