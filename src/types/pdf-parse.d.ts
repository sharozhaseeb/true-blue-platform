declare module "pdf-parse" {
  interface PdfData {
    /** Number of pages */
    numpages: number;
    /** Number of rendered pages */
    numrender: number;
    /** PDF info */
    info: Record<string, any>;
    /** PDF metadata */
    metadata: any;
    /** PDF version */
    version: string;
    /** All text content */
    text: string;
  }

  interface PdfOptions {
    /** First page to parse (1-indexed) */
    pagerender?: (pageData: any) => Promise<string>;
    /** Max number of pages to parse. Use -1 for all pages. */
    max?: number;
    /** PDF.js version */
    version?: string;
  }

  function pdfParse(
    dataBuffer: Buffer,
    options?: PdfOptions
  ): Promise<PdfData>;

  export = pdfParse;
}
