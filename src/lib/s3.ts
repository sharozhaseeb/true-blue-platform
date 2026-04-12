import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
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
 * Upload a buffer to S3 with AES-256 server-side encryption.
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
      ServerSideEncryption: "AES256",
    })
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
