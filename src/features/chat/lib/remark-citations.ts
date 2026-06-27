import type { Root, Text } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

const CITATION_PATTERN = /\[S[1-9][0-9]*\]/g;

/**
 * Remark plugin that scans mdast text nodes for canonical citation markers like
 * `[S1]`, `[S2]` (produced by `finalizePublicChatOutput`) and replaces each
 * match with a custom inline node. The node is rendered by react-markdown as a
 * `citation` element (via `data.hName`/`data.hProperties`), which is mapped to
 * the {@link Citation} component through `MarkdownTextPrimitive`'s `components`
 * prop. All surrounding text is preserved exactly.
 */
export const remarkCitations: Plugin<[], Root> = () => {
  return (tree) => {
    visit(tree, "text", (node: Text, index, parent) => {
      if (
        parent == null ||
        typeof index !== "number" ||
        // Don't rewrite text inside link targets where a `[S1]` would not be a
        // standalone marker. (Code nodes never contain text children.)
        parent.type === "link" ||
        parent.type === "linkReference"
      ) {
        return;
      }

      const value = node.value;
      CITATION_PATTERN.lastIndex = 0;
      if (!CITATION_PATTERN.test(value)) {
        return;
      }

      const replacement: Array<Text | CitationNode> = [];
      let lastIndex = 0;
      CITATION_PATTERN.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = CITATION_PATTERN.exec(value)) !== null) {
        const marker = match[0];
        const start = match.index;
        if (start > lastIndex) {
          replacement.push({
            type: "text",
            value: value.slice(lastIndex, start),
          });
        }

        replacement.push(createCitationNode(marker));
        lastIndex = start + marker.length;
      }

      if (lastIndex < value.length) {
        replacement.push({ type: "text", value: value.slice(lastIndex) });
      }

      parent.children.splice(index, 1, ...replacement);
      // Skip over the nodes we just inserted.
      return index + replacement.length;
    });
  };
};

type CitationNode = Text & {
  data: {
    hName: "citation";
    hProperties: { marker: string };
  };
};

function createCitationNode(marker: string): CitationNode {
  return {
    type: "text",
    // Fallback text content if the custom component is not registered.
    value: marker,
    data: {
      hName: "citation",
      hProperties: { marker },
    },
  };
}
