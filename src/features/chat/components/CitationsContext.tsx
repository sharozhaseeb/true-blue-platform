"use client";

import { createContext, useContext, useMemo } from "react";

import type { ChatCitation } from "../lib/types";

type CitationsContextValue = {
  /** marker (e.g. "[S1]") -> source */
  byMarker: Map<string, ChatCitation>;
  /** Jump to / highlight a source in the expanded CitationPanel list. */
  onJumpToSource: (marker: string) => void;
};

const CitationsContext = createContext<CitationsContextValue | null>(null);

export function CitationsProvider({
  sources,
  onJumpToSource,
  children,
}: {
  sources: ChatCitation[];
  onJumpToSource: (marker: string) => void;
  children: React.ReactNode;
}) {
  const value = useMemo<CitationsContextValue>(() => {
    const byMarker = new Map<string, ChatCitation>();
    sources.forEach((source, index) => {
      const marker = source.marker ?? `[S${index + 1}]`;
      if (!byMarker.has(marker)) {
        byMarker.set(marker, source);
      }
    });
    return { byMarker, onJumpToSource };
  }, [sources, onJumpToSource]);

  return (
    <CitationsContext.Provider value={value}>
      {children}
    </CitationsContext.Provider>
  );
}

export function useCitationSource(marker: string): {
  source: ChatCitation | null;
  onJumpToSource: () => void;
} {
  const context = useContext(CitationsContext);
  const source = context?.byMarker.get(marker) ?? null;
  return {
    source,
    onJumpToSource: () => context?.onJumpToSource(marker),
  };
}
