import { isRecord } from "./types";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

export type UploadValidationError = {
  file: File;
  reason: string;
};

/**
 * Client-side validation for selected upload files. Splits the drop into
 * accepted files and rejected files with a human-readable reason. PDF only,
 * with a reasonable size cap.
 */
export function validateUploadFiles(files: File[]): {
  accepted: File[];
  rejected: UploadValidationError[];
} {
  const accepted: File[] = [];
  const rejected: UploadValidationError[] = [];

  for (const file of files) {
    const isPdf =
      file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      rejected.push({ file, reason: "Only PDF files are supported." });
      continue;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      rejected.push({
        file,
        reason: `File is larger than ${Math.round(
          MAX_UPLOAD_BYTES / (1024 * 1024)
        )} MB.`,
      });
      continue;
    }
    accepted.push(file);
  }

  return { accepted, rejected };
}

type UploadedDocument = {
  id: string;
  originalName?: string;
  filename?: string;
  status?: string;
  [key: string]: unknown;
};

type UploadResult = {
  status: number;
  document: UploadedDocument | null;
  message?: string;
};

/**
 * Upload a single file via XHR so we get a determinate progress signal from
 * `xhr.upload.onprogress`. Mirrors the existing `fetchWithAuth` contract:
 * cookie-based credentials plus a one-shot refresh-and-retry on 401.
 */
export async function uploadFileWithProgress(input: {
  file: File;
  url: string;
  onProgress: (percent: number) => void;
  signal?: AbortSignal;
}): Promise<UploadResult> {
  const { signal } = input;

  // Attach the abort listener once here (not per-XHR), so the 401 retry below
  // does not stack a second listener. The currently in-flight XHR is tracked
  // via a ref so abort() reaches whichever request is live.
  const activeXhr: { current: XMLHttpRequest | null } = { current: null };
  if (signal?.aborted) {
    throw new DOMException("Upload aborted", "AbortError");
  }
  const onAbort = () => activeXhr.current?.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const result = await sendUploadXhr(input, activeXhr);
    if (result.status !== 401) {
      return result;
    }

    // Match fetchWithAuth: try a token refresh once, then retry the upload.
    const refresh = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "include",
    });
    if (!refresh.ok) {
      return result;
    }
    input.onProgress(0);
    return await sendUploadXhr(input, activeXhr);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

function sendUploadXhr(
  input: {
    file: File;
    url: string;
    onProgress: (percent: number) => void;
    signal?: AbortSignal;
  },
  activeXhr: { current: XMLHttpRequest | null }
): Promise<UploadResult> {
  const { file, url, onProgress, signal } = input;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }

    const xhr = new XMLHttpRequest();
    activeXhr.current = xhr;
    xhr.open("POST", url, true);
    xhr.withCredentials = true;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        // Never report 100% from progress alone; snap to 100 only on success.
        onProgress(Math.min(99, Math.floor((event.loaded / event.total) * 100)));
      }
    };

    xhr.onload = () => {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(xhr.responseText);
      } catch {
        parsed = null;
      }
      const document =
        isRecord(parsed) && isRecord(parsed.document)
          ? (parsed.document as UploadedDocument)
          : null;
      const message =
        isRecord(parsed) && typeof parsed.message === "string"
          ? parsed.message
          : undefined;
      onProgress(100);
      resolve({ status: xhr.status, document, message });
    };

    xhr.onerror = () => reject(new Error("Network error during upload"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}
