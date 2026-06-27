"use client";

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

import { citationSnippet, formatPageRange } from "../lib/format";
import { useCitationSource } from "./CitationsContext";

/**
 * Renders a canonical citation marker (`[S1]`, `[S2]`, …) that the
 * {@link remarkCitations} plugin emitted as a `citation` element.
 *
 * The marker string arrives via `props.marker` (set as `data.hProperties` by
 * the plugin). We resolve it to a concrete source via the CitationsContext that
 * `ChatBubble` populates. If no source matches, we render the marker as plain
 * text so there is no broken hover affordance.
 */
export function Citation({
  marker,
  children,
}: {
  marker?: string;
  children?: React.ReactNode;
}) {
  // `marker` is the resolved marker (e.g. "[S1]"); fall back to text children.
  const markerText =
    marker ?? (typeof children === "string" ? children : "");
  const { source, onJumpToSource } = useCitationSource(markerText);

  if (!source) {
    // No matching source — render plain text, no broken hover.
    return <>{markerText}</>;
  }

  const numberLabel = markerText.replace(/[[\]]/g, "");
  const filename = source.filename ?? "Source document";
  const pageLabel = source.pageLabel ?? formatPageRange(source);
  const snippet = citationSnippet(source);

  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <button
            type="button"
            onClick={onJumpToSource}
            aria-label={`Citation ${markerText}: ${filename}, ${pageLabel}. Jump to source.`}
            className="mx-0.5 inline-flex items-baseline rounded-[0.4rem] bg-blue-600/10 px-1 align-baseline text-[0.65rem] font-semibold text-blue-700 no-underline ring-1 ring-blue-600/15 transition hover:bg-blue-600 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          >
            <sup className="leading-none">{numberLabel}</sup>
          </button>
        }
      />
      <HoverCardContent className="w-72 space-y-1.5">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-800">
          <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[0.7rem] text-white">
            {markerText}
          </span>
          <span className="min-w-0 truncate">{filename}</span>
        </div>
        <p className="text-[0.7rem] font-medium text-slate-500">{pageLabel}</p>
        <p className="max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-5 text-slate-600">
          {snippet}
        </p>
      </HoverCardContent>
    </HoverCard>
  );
}
