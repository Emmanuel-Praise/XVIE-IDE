/*
 * Maps binary document files to viewer kinds. Text documents (marked down,
 * code, CSV, …) are handled by the main editor and never reach this registry.
 */

/** Spreadsheet-like text files rendered as an editable grid. */
export function isCsvFile(path: string): boolean {
  const ext = extensionOf(path);
  return ext === "csv" || ext === "tsv";
}

export type DocumentKind = "pdf" | "word" | "excel" | "powerpoint" | "image";

export function extensionOf(path: string): string {
  const ext = (path.split(/[\\/]/).pop() ?? "").split(".").pop();
  return ext ? ext.toLowerCase() : "";
}

export function documentKindOf(path: string): DocumentKind | null {
  switch (extensionOf(path)) {
    case "pdf":
      return "pdf";
    case "docx":
    case "doc":
    case "rtf":
      return "word";
    case "xlsx":
    case "xls":
    case "xlsm":
      return "excel";
    case "pptx":
    case "ppt":
    case "pptm":
      return "powerpoint";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
    case "bmp":
    case "ico":
    case "avif":
    case "tif":
    case "tiff":
    case "heic":
      return "image";
    default:
      return null;
  }
}

/** True for legacy OLE2 formats with no in-app renderer. */
export function isLegacyFormat(path: string): boolean {
  switch (extensionOf(path)) {
    case "doc":
    case "ppt":
      return true;
    default:
      return false;
  }
}

/** System application label used by the "Open in …" button. */
export function documentAppLabel(kind: DocumentKind): string {
  switch (kind) {
    case "pdf":
      return "PDF viewer";
    case "word":
      return "Word";
    case "excel":
      return "Excel";
    case "powerpoint":
      return "PowerPoint";
    case "image":
      return "Image viewer";
  }
}

/** Human label shown in the viewer chrome. */
export function documentKindLabel(kind: DocumentKind): string {
  switch (kind) {
    case "pdf":
      return "PDF";
    case "word":
      return "Word document";
    case "excel":
      return "Spreadsheet";
    case "powerpoint":
      return "PowerPoint";
    case "image":
      return "Image";
  }
}