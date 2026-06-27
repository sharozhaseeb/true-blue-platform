"use client";

import { useCallback } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { CheckCircle2, FileUp, Loader2, UploadCloud, XCircle } from "lucide-react";

import { Progress } from "@/components/ui/progress";

import { MAX_UPLOAD_BYTES } from "../lib/upload";

export type UploadPhase = "uploading" | "processing" | "completed" | "error";

export type UploadRow = {
  id: string;
  name: string;
  phase: UploadPhase;
  /** 0-100 during the upload phase; ignored otherwise. */
  percent: number;
  error?: string;
};

export function UploadPanel({
  rows,
  disabled,
  disabledReason,
  onFilesAccepted,
  onFilesRejected,
  onDismissRow,
}: {
  rows: UploadRow[];
  disabled: boolean;
  disabledReason: string | null;
  onFilesAccepted: (files: File[]) => void;
  onFilesRejected: (rejections: FileRejection[]) => void;
  onDismissRow: (id: string) => void;
}) {
  const onDrop = useCallback(
    (accepted: File[], rejections: FileRejection[]) => {
      if (accepted.length > 0) {
        onFilesAccepted(accepted);
      }
      if (rejections.length > 0) {
        onFilesRejected(rejections);
      }
    },
    [onFilesAccepted, onFilesRejected]
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxSize: MAX_UPLOAD_BYTES,
    multiple: true,
    disabled,
    noClick: true,
    noKeyboard: true,
  });

  return (
    <div className="space-y-2">
      <div
        {...getRootProps()}
        className={`rounded-xl border-2 border-dashed px-4 py-5 text-center transition ${
          disabled
            ? "cursor-not-allowed border-slate-200 bg-slate-50 opacity-70"
            : isDragActive
              ? "border-blue-500 bg-blue-50"
              : "border-slate-200 bg-white hover:border-slate-300"
        }`}
      >
        <input {...getInputProps()} aria-label="Upload PDF files" />
        <UploadCloud className="mx-auto h-6 w-6 text-slate-500" />
        <p className="mt-2 text-sm font-semibold text-slate-700">
          {isDragActive ? "Drop PDFs to upload" : "Drag and drop PDFs here"}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          PDF only, up to {Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB each.
        </p>
        <button
          type="button"
          onClick={open}
          disabled={disabled}
          className="mt-3 inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400"
        >
          <FileUp className="h-4 w-4" />
          Choose files
        </button>
        {disabled && disabledReason ? (
          <p className="mt-2 text-xs leading-5 text-slate-500">{disabledReason}</p>
        ) : null}
      </div>

      {rows.length > 0 ? (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <UploadRowIcon phase={row.phase} />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-slate-700">
                  {row.name}
                </span>
                {row.phase === "completed" || row.phase === "error" ? (
                  <button
                    type="button"
                    onClick={() => onDismissRow(row.id)}
                    className="rounded-full px-1.5 text-[0.65rem] font-semibold text-slate-500 transition hover:text-slate-700"
                    aria-label={`Dismiss ${row.name}`}
                  >
                    Clear
                  </button>
                ) : null}
              </div>

              {row.phase === "uploading" ? (
                <div className="mt-2 space-y-1">
                  <Progress value={row.percent} className="gap-1" />
                  <p className="text-[0.65rem] text-slate-500">
                    Uploading… {row.percent}%
                  </p>
                </div>
              ) : null}

              {row.phase === "processing" ? (
                <div className="mt-2 space-y-1">
                  {/* Indeterminate: server-side processing has no progress signal,
                      so show an animated full-width bar + explicit phase text. */}
                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
                  </div>
                  <p className="text-[0.65rem] text-slate-500">
                    Processing… (extracting and indexing)
                  </p>
                </div>
              ) : null}

              {row.phase === "completed" ? (
                <p className="mt-1 text-[0.65rem] font-medium text-emerald-700">
                  Ready for retrieval
                </p>
              ) : null}

              {row.phase === "error" ? (
                <p className="mt-1 text-[0.65rem] font-medium text-rose-700">
                  {row.error ?? "Upload failed"}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function UploadRowIcon({ phase }: { phase: UploadPhase }) {
  if (phase === "completed") {
    return <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />;
  }
  if (phase === "error") {
    return <XCircle className="h-4 w-4 shrink-0 text-rose-600" />;
  }
  return <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-500" />;
}
