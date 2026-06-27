import "react";

type CitationElementProps = React.DetailedHTMLProps<
  React.HTMLAttributes<HTMLElement> & { marker?: string },
  HTMLElement
>;

// Register the custom `citation` inline element emitted by the
// `remarkCitations` plugin so react-markdown's `components` prop (typed as
// `{ [K in keyof JSX.IntrinsicElements]?: ... }`) accepts `{ citation: Citation }`.
// React 19 resolves `JSX` to `React.JSX`; older tooling reads the global `JSX`,
// so augment both to be safe.
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      citation: CitationElementProps;
    }
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      citation: CitationElementProps;
    }
  }
}
