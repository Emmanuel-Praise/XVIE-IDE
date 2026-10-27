import type { DocumentKind } from "./documentKinds";
import { documentKindOf, isLegacyFormat } from "./documentKinds";
import { LegacyNotice } from "./doc-shell";
import PdfViewer from "./pdf-viewer";
import DocxViewer from "./docx-viewer";
import XlsxViewer from "./xlsx-viewer";
import PptxViewer from "./pptx-viewer";
import ImageViewer from "./image-viewer";

interface DocumentViewerProps {
  path: string;
  name: string;
}

export default function DocumentViewer({ path, name }: DocumentViewerProps): React.JSX.Element {
  const kind = documentKindOf(path);
  if (!kind) {
    throw new Error("DocumentViewer called for a non-document file");
  }
  if (isLegacyFormat(path)) {
    return <LegacyNotice kind={kind} path={path} />;
  }
  switch (kind) {
    case "pdf":
      return <PdfViewer path={path} name={name} kind={kind} />;
    case "word":
      return <DocxViewer path={path} name={name} kind={kind} />;
    case "excel":
      return <XlsxViewer path={path} name={name} kind={kind} />;
    case "powerpoint":
      return <PptxViewer path={path} name={name} kind={kind} />;
    case "image":
      return <ImageViewer path={path} name={name} kind={kind} />;
  }
}

export type { DocumentKind };