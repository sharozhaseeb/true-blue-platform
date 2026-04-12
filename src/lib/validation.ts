const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const PDF_MAGIC_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a PDF upload: extension, MIME type, and file size.
 * Does NOT check magic bytes (requires buffer).
 */
export function validatePdfUpload(
  filename: string,
  mimeType: string,
  fileSize: number
): ValidationResult {
  // Check extension
  if (!filename.toLowerCase().endsWith(".pdf")) {
    return { valid: false, error: "File must have a .pdf extension" };
  }

  // Check MIME type
  if (mimeType !== "application/pdf") {
    return {
      valid: false,
      error: "File must be a PDF (application/pdf)",
    };
  }

  // Check file size
  if (fileSize > MAX_FILE_SIZE) {
    return {
      valid: false,
      error: `File size exceeds maximum of 20MB`,
    };
  }

  return { valid: true };
}

/**
 * Validate that the first 5 bytes of a buffer are the PDF magic bytes (%PDF-).
 */
export function validatePdfMagicBytes(buffer: Buffer): ValidationResult {
  if (buffer.length < 5) {
    return { valid: false, error: "File is too small to be a valid PDF" };
  }

  for (let i = 0; i < PDF_MAGIC_BYTES.length; i++) {
    if (buffer[i] !== PDF_MAGIC_BYTES[i]) {
      return {
        valid: false,
        error: "File does not appear to be a valid PDF (invalid magic bytes)",
      };
    }
  }

  return { valid: true };
}

/**
 * Sanitize a filename for safe storage:
 * - Strip path separators, null bytes, and non-ASCII characters
 * - Replace spaces with underscores
 * - Truncate to 200 characters
 * - Preserve the .pdf extension
 */
export function sanitizeFilename(filename: string): string {
  // Strip path separators and null bytes
  let sanitized = filename.replace(/[/\\:\0]/g, "");

  // Strip non-ASCII characters
  sanitized = sanitized.replace(/[^\x20-\x7E]/g, "");

  // Replace spaces with underscores
  sanitized = sanitized.replace(/\s+/g, "_");

  // Remove any remaining dangerous characters
  sanitized = sanitized.replace(/[<>"|?*]/g, "");

  // Truncate to 200 characters (preserve .pdf extension)
  if (sanitized.length > 200) {
    const ext = ".pdf";
    sanitized = sanitized.substring(0, 200 - ext.length) + ext;
  }

  // Fallback if filename is empty after sanitization
  if (!sanitized || sanitized === ".pdf") {
    sanitized = "document.pdf";
  }

  return sanitized;
}
