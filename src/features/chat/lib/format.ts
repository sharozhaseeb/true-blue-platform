import type { ChatCitation } from "./types";

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatGeneratedAt(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

export function formatPageRange(citation: ChatCitation) {
  if (citation.pageStart === citation.pageEnd) {
    return `Page ${citation.pageStart}`;
  }

  return `Pages ${citation.pageStart}-${citation.pageEnd}`;
}

export function formatSourceCount(count: number | null): string {
  if (count === null) {
    return "All sources";
  }

  return `${count} source${count === 1 ? "" : "s"}`;
}

export function citationSnippet(citation: ChatCitation): string {
  return citation.snippetFull?.trim() ? citation.snippetFull : citation.snippet;
}
