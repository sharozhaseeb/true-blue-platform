"use client";

import { useMemo, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clipboard,
  Cpu,
  Download,
  Info,
  ShieldCheck,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { CONFIDENCE_DOT_CLASS } from "../lib/coverage";
import {
  copyValue,
  exportOutputCsv,
  exportOutputJson,
} from "../lib/export";
import { formatGeneratedAt } from "../lib/format";
import { metadataNumber, metadataString } from "../lib/parse-output";
import type { ConfidenceLabel, StructuredChatOutputV1 } from "../lib/types";
import { RawOutputTab } from "./RawOutputTab";

const CONFIDENCE_TEXT_CLASS: Record<ConfidenceLabel, string> = {
  high: "text-[var(--color-confidence-high)]",
  // The light amber tint token is too low-contrast as text on white; use a
  // darker amber for the TEXT only (ring/dot tints keep the light token).
  medium: "text-amber-700",
  low: "text-[var(--color-confidence-low)]",
  none: "text-[var(--color-confidence-none)]",
};

const CONFIDENCE_RING_CLASS: Record<ConfidenceLabel, string> = {
  high: "ring-[var(--color-confidence-high)]/35 bg-[var(--color-confidence-high)]/10",
  medium:
    "ring-[var(--color-confidence-medium)]/35 bg-[var(--color-confidence-medium)]/10",
  low: "ring-[var(--color-confidence-low)]/35 bg-[var(--color-confidence-low)]/10",
  none: "ring-[var(--color-confidence-none)]/30 bg-[var(--color-confidence-none)]/10",
};

const CONFIDENCE_LABEL_TEXT: Record<ConfidenceLabel, string> = {
  high: "High support",
  medium: "Medium support",
  low: "Low support",
  none: "No support",
};

const WARNING_TONE: Record<
  "info" | "warning" | "error",
  { wrap: string; icon: typeof Info }
> = {
  info: { wrap: "border-sky-200 bg-sky-50 text-sky-800", icon: Info },
  warning: {
    wrap: "border-amber-200 bg-amber-50 text-amber-800",
    icon: AlertTriangle,
  },
  error: { wrap: "border-rose-200 bg-rose-50 text-rose-800", icon: AlertCircle },
};

function CopyValueButton({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Copy ${label}`}
            onClick={async () => {
              const ok = await copyValue(value);
              setCopied(ok);
              if (ok) {
                window.setTimeout(() => setCopied(false), 1200);
              }
            }}
          />
        }
      >
        {copied ? (
          <Check className="text-emerald-600" />
        ) : (
          <Clipboard className="text-slate-400" />
        )}
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : `Copy ${label}`}</TooltipContent>
    </Tooltip>
  );
}

export function AnswerInsights({ output }: { output: StructuredChatOutputV1 }) {
  const confidence = output.support.confidenceLabel;
  const generatedAtRaw = metadataString(output.metadata, "generatedAt");
  const generatedAt = generatedAtRaw ? formatGeneratedAt(generatedAtRaw) : null;
  const model = metadataString(output.metadata, "model");
  const inputTokens = metadataNumber(output.metadata, "inputTokens");
  const outputTokens = metadataNumber(output.metadata, "outputTokens");
  const hasUsage = inputTokens !== null || outputTokens !== null;

  const labelByDocumentId = useMemo(() => {
    const map = new Map<string, string>();
    for (const source of output.sources) {
      if (source.filename) {
        map.set(source.documentId, source.filename);
      }
    }
    return map;
  }, [output.sources]);

  const citedDocumentCount = output.support.citedDocumentCount;
  const selectedDocumentCount = output.support.selectedDocumentCount;
  const sourcesSummary =
    selectedDocumentCount > 0
      ? `Cited ${citedDocumentCount} of ${selectedDocumentCount} selected source${
          selectedDocumentCount === 1 ? "" : "s"
        }`
      : `Cited ${output.support.sourceCount} source${
          output.support.sourceCount === 1 ? "" : "s"
        }`;

  const coverageRows = output.coverage.selectedDocumentIds.map((documentId) => {
    const used = output.coverage.finalByDocumentId[documentId] ?? 0;
    const noEvidence = output.coverage.noEvidenceDocumentIds.includes(documentId);
    const tone = used > 0 ? "used" : noEvidence ? "noEvidence" : "selected";
    const label =
      used > 0 ? "Used" : noEvidence ? "No evidence" : "Selected";
    return {
      documentId,
      name: labelByDocumentId.get(documentId) ?? documentId,
      tone,
      label,
    } as const;
  });

  return (
    <Card size="sm" className="bg-card/95">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldCheck className="h-4 w-4 text-slate-500" />
            Answer insights
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    aria-label="Export answer as JSON"
                    onClick={() => exportOutputJson(output)}
                  />
                }
              >
                <Download />
                JSON
              </TooltipTrigger>
              <TooltipContent>Export the answer envelope as JSON</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    aria-label="Export answer as CSV"
                    onClick={() => exportOutputCsv(output)}
                  />
                }
              >
                <Download />
                CSV
              </TooltipTrigger>
              <TooltipContent>
                Export support, coverage, and sources as CSV
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Confidence (F27) — prominent, visible by default */}
        <div
          className={`flex flex-wrap items-center gap-3 rounded-card px-3 py-2 ring-1 ${CONFIDENCE_RING_CLASS[confidence]}`}
        >
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Confidence: ${CONFIDENCE_LABEL_TEXT[confidence]}`}
                />
              }
            >
              <span
                className={`h-2.5 w-2.5 rounded-full ${CONFIDENCE_DOT_CLASS[confidence]}`}
                aria-hidden="true"
              />
              <span className={CONFIDENCE_TEXT_CLASS[confidence]}>
                {CONFIDENCE_LABEL_TEXT[confidence]}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {output.support.confidenceBasis}
            </TooltipContent>
          </Tooltip>
          <span className="text-xs text-muted-foreground">{sourcesSummary}</span>
        </div>
      </CardHeader>

      <CardContent>
        <Tabs defaultValue="summary" className="gap-3">
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="raw">Raw</TabsTrigger>
          </TabsList>

          <TabsContent value="summary" className="space-y-4">
            {/* Sources summary (F28) */}
            <section className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Sources
              </p>
              <div className="flex items-center gap-2">
                <p className="text-sm text-foreground">{sourcesSummary}</p>
                <CopyValueButton label="sources summary" value={sourcesSummary} />
              </div>
            </section>

            {coverageRows.length > 0 ? (
              <>
                <Separator />
                <section className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Coverage
                  </p>
                  <ul className="space-y-1.5">
                    {coverageRows.map((row) => (
                      <li
                        key={row.documentId}
                        className="flex items-center justify-between gap-2"
                      >
                        <span className="min-w-0 truncate text-sm text-foreground">
                          {row.name}
                        </span>
                        <Badge
                          variant={
                            row.tone === "used"
                              ? "default"
                              : row.tone === "noEvidence"
                                ? "destructive"
                                : "secondary"
                          }
                        >
                          {row.label}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            ) : null}

            {output.warnings.length > 0 ? (
              <>
                <Separator />
                <section className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Warnings
                  </p>
                  <ul className="space-y-1.5">
                    {output.warnings.map((warning, index) => {
                      const tone = WARNING_TONE[warning.severity];
                      const Icon = tone.icon;
                      return (
                        <li
                          key={`${warning.code}-${index}`}
                          className={`flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs leading-5 ${tone.wrap}`}
                        >
                          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                          <span>
                            <span className="font-semibold">
                              {warning.code.replace(/_/g, " ")}
                            </span>
                            {warning.message ? ` — ${warning.message}` : null}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              </>
            ) : null}

            <Separator />
            {/* Details / provenance (consolidates Phase-A dot/details) */}
            <section className="space-y-1.5">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Details
              </p>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                {generatedAt ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt>Generated</dt>
                    <dd className="text-foreground">
                      <time dateTime={generatedAtRaw ?? undefined}>{generatedAt}</time>
                    </dd>
                  </div>
                ) : null}
                {model ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt className="inline-flex items-center gap-1">
                      <Cpu className="h-3 w-3" /> Model
                    </dt>
                    <dd className="truncate text-foreground">{model}</dd>
                  </div>
                ) : null}
                {hasUsage ? (
                  <div className="flex items-center justify-between gap-2">
                    <dt>Tokens</dt>
                    <dd className="text-foreground">
                      {inputTokens ?? 0} in / {outputTokens ?? 0} out
                    </dd>
                  </div>
                ) : null}
                <div className="flex items-center justify-between gap-2">
                  <dt>Retrieval</dt>
                  <dd className="text-foreground">{output.support.retrievalMode}</dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt>Template</dt>
                  <dd className="truncate text-foreground">
                    {output.templateId} v{output.templateVersion}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <dt>Status</dt>
                  <dd className="text-foreground">
                    {output.status.replace(/_/g, " ")}
                  </dd>
                </div>
              </dl>
            </section>
          </TabsContent>

          <TabsContent value="raw">
            <RawOutputTab output={output} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
