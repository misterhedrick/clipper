// Shared by the Google Docs and Notion readers.

export type BriefReaderErrorCode = "not_a_google_doc" | "unsupported_doc" | "not_public" | "not_found" | "fetch_failed";

export class BriefReaderError extends Error {
  constructor(
    public readonly code: BriefReaderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BriefReaderError";
  }
}

export type DocLink = { text: string; url: string };

export type ReaderDeps = { fetch?: typeof fetch };
