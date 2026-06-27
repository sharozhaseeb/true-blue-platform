"use client";

import { useState } from "react";
import { Clipboard } from "lucide-react";

import { Button } from "@/components/ui/button";
import { copyValue } from "../lib/export";
import type { StructuredChatOutputV1 } from "../lib/types";

export function RawOutputTab({ output }: { output: StructuredChatOutputV1 }) {
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(output.raw, null, 2);

  async function handleCopy() {
    const ok = await copyValue(json);
    setCopied(ok);
    if (ok) {
      window.setTimeout(() => setCopied(false), 1200);
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[0.7rem] font-medium text-muted-foreground">
          Full answer envelope (developer view)
        </p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={handleCopy}
          aria-label="Copy raw JSON"
        >
          <Clipboard />
          {copied ? "Copied" : "Copy JSON"}
        </Button>
      </div>
      <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 px-3 py-3 text-[0.68rem] leading-5 text-slate-100">
        {json}
      </pre>
    </div>
  );
}
