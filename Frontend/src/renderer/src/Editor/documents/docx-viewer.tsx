import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import type { DocumentKind } from "./documentKinds";
import DocShell, { DocError, DocLoading } from "./doc-shell";
import { retryDocumentBytes, useDocumentBytes } from "./useDocumentBytes";

/*
 * View-only Word document renderer.
 *
 * Renders word/document.xml directly: paragraphs, runs with fonts/sizes,
 * tables with widths and shading, and inline images, laid out on a paper
 * canvas using the section page size + margins.
 */

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const W_NS_PURL = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const A14_NS = "http://schemas.microsoft.com/office/drawing/2010/main";
const R_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const V_NS = "urn:schemas-microsoft-com:vml";
const EMU_PER_INCH = 914400;
const PX_PER_INCH = 96;
const TWIPS_PER_INCH = 1440;

interface WordRunStyle {
  font: string;
  sizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  caps: boolean;
  smallCaps: boolean;
  vertAlign: "superscript" | "subscript" | "baseline";
  color: string | null;
  highlight: string | null;
}

const DEFAULT_STYLE: WordRunStyle = {
  font: "Calibri",
  sizePt: 11,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  caps: false,
  smallCaps: false,
  vertAlign: "baseline",
  color: null,
  highlight: null
};

interface WordToken {
  kind: "text" | "tab" | "br" | "image";
  text: string;
  imageSrc?: string;
  imageW?: number;
  imageH?: number;
  style: WordRunStyle;
}

interface WordParagraph {
  tokens: WordToken[];
  text: string;
  jc: string;
  bullet: boolean;
  indLeft: number;
  indFirst: number;
  spBeforePt: number;
  spAfterPt: number;
  spLine: number;
  shd: string | null;
  elt: Element | null;
}

interface WordCell {
  paragraphs: WordParagraph[];
  gridSpan: number;
}

interface WordRow {
  cells: WordCell[];
}

interface WordTable {
  kind: "table";
  colWidths: number[];
  rows: WordRow[];
  widths: number[];
}

interface WordImage extends WordToken {
  kind: "image";
}

interface WordModel {
  items: (WordParagraph | WordTable)[];
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  contentWidth: number;
}

/* ------------------------------------------------------------------ */
/* XML helpers                                                         */
/* ------------------------------------------------------------------ */

function first(el: Element, ns: string, local: string): Element | null {
  return el.getElementsByTagNameNS(ns, local).item(0) ?? null;
}

function attr(el: Element | null, name: string): string | null {
  return el ? el.getAttribute(name) : null;
}

function attrNum(el: Element | null, name: string, fallback: number): number {
  const value = parseFloat(attr(el, name) ?? "");
  return Number.isFinite(value) ? value : fallback;
}

function descendantsTo(el: Element, local: string): Element[] {
  return Array.from(el.getElementsByTagNameNS(W_NS, local));
}

async function relsTargets(zip: JSZip, relsPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const file = zip.file(relsPath);
  if (!file) return map;
  try {
    const xml = await file.async("string");
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    for (const rel of Array.from(doc.getElementsByTagNameNS(R_NS, "Relationship"))) {
      const id = attr(rel, "Id");
      const target = attr(rel, "Target");
      if (id && target) map.set(id, target);
    }
  } catch {
    /* ignore */
  }
  return map;
}

function normalizeRelTarget(relsDir: string, target: string): string {
  const parts = relsDir.split("/").filter(Boolean);
  for (const segment of target.split("/")) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function contentTypeFor(target: string): string {
  const ext = target.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpeg":
    case "jpg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}

/* ------------------------------------------------------------------ */
/* Styles                                                              */
/* ------------------------------------------------------------------ */

const highlightMap: Record<string, string> = {
  black: "#000000",
  blue: "#00a8f0",
  cyan: "#00ffff",
  darkBlue: "#000080",
  darkCyan: "#008080",
  darkGreen: "#008000",
  darkMagenta: "#800080",
  darkRed: "#800000",
  darkYellow: "#808000",
  green: "#00ff00",
  lightBlue: "#add8e6",
  lightCyan: "#e0ffff",
  lightGreen: "#90ee90",
  lightMagenta: "#ffb6c1",
  lightRed: "#ffa07a",
  lightYellow: "#ffffe0",
  magenta: "#ff00ff",
  red: "#ff0000",
  white: "#ffffff",
  yellow: "#ffff00"
};

function runStyleOf(rPr: Element | null): WordRunStyle {
  const style: WordRunStyle = { ...DEFAULT_STYLE };
  if (!rPr) return style;
  const fonts = first(rPr, W_NS, "rFonts");
  const ascii = fonts && attr(fonts, "ascii");
  if (ascii) style.font = ascii;
  const sz = parseFloat(attr(first(rPr, W_NS, "sz"), "val") ?? "");
  if (Number.isFinite(sz) && sz > 0) style.sizePt = sz / 2;
  if (first(rPr, W_NS, "b")) style.bold = true;
  if (first(rPr, W_NS, "i")) style.italic = true;
  const u = first(rPr, W_NS, "u");
  style.underline = !!u && (attr(u, "val") ?? "single") !== "none";
  if (first(rPr, W_NS, "strike")) style.strike = true;
  if (first(rPr, W_NS, "caps")) style.caps = true;
  if (first(rPr, W_NS, "smallCaps")) style.smallCaps = true;
  const va = attr(first(rPr, W_NS, "vertAlign"), "val");
  style.vertAlign = va === "superscript" ? "superscript" : va === "subscript" ? "subscript" : "baseline";
  const color = attr(first(rPr, W_NS, "color"), "val");
  if (color && color !== "auto" && /^[0-9a-fA-F]{6}$/.test(color)) style.color = `#${color.toLowerCase()}`;
  const highlight = attr(first(rPr, W_NS, "highlight"), "val");
  if (highlight && highlight !== "none" && highlightMap[highlight]) style.highlight = highlightMap[highlight];
  return style;
}

function shadingOf(pPr: Element | null): string | null {
  const shd = pPr ? first(pPr, W_NS, "shd") : null;
  const fill = shd ? attr(shd, "fill") : null;
  return fill && /^[0-9a-fA-F]{6}$/.test(fill) ? `#${fill.toLowerCase()}` : null;
}

/* ------------------------------------------------------------------ */
/* Paragraph parsing                                                   */
/* ------------------------------------------------------------------ */

function parseRun(r: Element, imageData: Map<string, string>): WordToken[] {
  const rPr = first(r, W_NS, "rPr");
  const style = runStyleOf(rPr);
  const tokens: WordToken[] = [];
  for (const child of Array.from(r.children)) {
    if (child.namespaceURI === W_NS && child.localName === "t") {
      tokens.push({ kind: "text", text: child.textContent ?? "", style });
    } else if (child.namespaceURI === W_NS && child.localName === "tab") {
      tokens.push({ kind: "tab", text: "\t", style });
    } else if (child.namespaceURI === W_NS && child.localName === "br") {
      tokens.push({ kind: "br", text: "\n", style });
    } else if (child.namespaceURI === W_NS && child.localName === "drawing") {
      const image = drawingImage(child, imageData);
      if (image) tokens.push(image);
    } else if (child.namespaceURI === V_NS && child.localName === "shape") {
      const imagedata = first(child, A_NS, "imagedata") ?? first(child, V_NS, "imagedata");
      const rid = imagedata ? attr(imagedata, "r:id") ?? attr(imagedata, "id") : null;
      const styleAttr = attr(child, "style") ?? "";
      const wMatch = /width:\s*([\d.]+)pt/i.exec(styleAttr);
      const hMatch = /height:\s*([\d.]+)pt/i.exec(styleAttr);
      const src = rid ? imageData.get(rid) : undefined;
      if (src) {
        tokens.push({
          kind: "image",
          text: "",
          imageSrc: src,
          imageW: wMatch ? parseFloat(wMatch[1]) * (PX_PER_INCH / 72) : 100,
          imageH: hMatch ? parseFloat(hMatch[1]) * (PX_PER_INCH / 72) : 100,
          style
        });
      }
    }
  }
  return tokens;
}

function drawingImage(drawing: Element, imageData: Map<string, string>): WordImage | null {
  const blip = first(drawing, A_NS, "blip");
  const embed = blip ? attr(blip, "embed") : null;
  if (!embed) return null;
  const src = imageData.get(embed) ?? imageData.get(`rId:${embed}`);
  if (!src) return null;
  const extent = first(drawing, A_NS, "extent");
  const cx = extent ? attrNum(extent, "cx", 0) : 0;
  const cy = extent ? attrNum(extent, "cy", 0) : 0;
  return {
    kind: "image",
    text: "",
    imageSrc: src,
    imageW: cx > 0 ? (cx / EMU_PER_INCH) * PX_PER_INCH : 100,
    imageH: cy > 0 ? (cy / EMU_PER_INCH) * PX_PER_INCH : 100,
    style: { ...DEFAULT_STYLE }
  };
}

function paragraphIndent(pPr: Element | null): { left: number; first: number } {
  if (!pPr) return { left: 0, first: 0 };
  const ind = first(pPr, W_NS, "ind");
  const left = ind ? attrNum(ind, "left", 0) / 20 : 0;
  const firstLine = ind ? attrNum(ind, "firstLine", 0) / 20 : 0;
  return { left, first: firstLine };
}

function paragraphSpacing(pPr: Element | null): { before: number; after: number; line: number } {
  if (!pPr) return { before: 0, after: 0, line: 0 };
  const sp = first(pPr, W_NS, "spacing");
  const before = sp ? attrNum(sp, "before", 0) / 20 : 0;
  const after = sp ? attrNum(sp, "after", 0) / 20 : 0;
  let line = 0;
  if (sp) {
    const rule = attr(sp, "lineRule") ?? "auto";
    if (rule === "auto") line = attrNum(sp, "line", 240) / 240;
    else if (rule === "atLeast" || rule === "exact") line = (attrNum(sp, "line", 240) / 240) * 0.83;
  }
  return { before, after, line: line > 0 ? line : 0 };
}

function textOfTokens(tokens: WordToken[]): string {
  return tokens.map((t) => t.text).join("");
}

function parseParagraph(
  p: Element,
  imageData: Map<string, string>,
  defaultStyle: WordRunStyle
): WordParagraph {
  const pPr = first(p, W_NS, "pPr");
  const jcAttr = pPr ? attr(first(pPr, W_NS, "jc"), "val") : null;
  const jc = jcAttr === "center" || jcAttr === "right" || jcAttr === "both" || jcAttr === "distribute" ? jcAttr : "left";
  const bullet = !!(pPr && first(pPr, W_NS, "numPr"));
  const { left, first: firstLine } = paragraphIndent(pPr);
  const { before, after, line } = paragraphSpacing(pPr);
  const shd = shadingOf(pPr);

  const paraDefault = pPr ? runStyleOf(first(pPr, W_NS, "rPr")) : defaultStyle;
  const tokens: WordToken[] = [];
  const visit = (node: Element): void => {
    for (const child of Array.from(node.children)) {
      if (child.namespaceURI !== W_NS) continue;
      if (child.localName === "r") {
        tokens.push(...parseRun(child, imageData));
      } else if (child.localName === "hyperlink") {
        visit(child);
      }
    }
  };
  visit(p);

  const text = textOfTokens(tokens);
  return {
    tokens,
    text,
    jc,
    bullet,
    indLeft: left,
    indFirst: firstLine,
    spBeforePt: before,
    spAfterPt: after,
    spLine: line,
    shd,
    elt: p
  };
}

/* ------------------------------------------------------------------ */
/* Tables + body                                                       */
/* ------------------------------------------------------------------ */

function parseTable(tbl: Element, imageData: Map<string, string>, defaultStyle: WordRunStyle): WordTable {
  const gridCols = descendantsTo(tbl, "gridCol").map((c) => attrNum(c, "w", 0));
  const widths = gridCols.length > 0 ? gridCols : Array.from(descendantsTo(tbl, "tr")[0]?.getElementsByTagNameNS(W_NS, "tc") ?? [])
    .map(() => 1);
  const rows: WordRow[] = [];
  for (const tr of Array.from(tbl.getElementsByTagNameNS(W_NS, "tr"))) {
    const cells: WordCell[] = [];
    for (const tc of Array.from(tr.getElementsByTagNameNS(W_NS, "tc"))) {
      const tcPr = first(tc, W_NS, "tcPr");
      const gridSpan = tcPr ? attrNum(first(tcPr, W_NS, "gridSpan"), "val", 1) : 1;
      const paragraphs = Array.from(tc.getElementsByTagNameNS(W_NS, "p")).map((p) =>
        parseParagraph(p, imageData, defaultStyle)
      );
      cells.push({ paragraphs, gridSpan: Math.max(gridSpan, 1) });
    }
    rows.push({ cells });
  }
  return { kind: "table", colWidths: gridCols, rows, widths };
}

async function buildModel(zip: JSZip, data: Uint8Array): Promise<WordModel> {
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("No word/document.xml found — this file cannot be displayed in-app.");
  const xml = (await docFile.async("string")).split(W_NS_PURL).join(W_NS);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const body = first(doc.documentElement, W_NS, "body");
  if (!body) throw new Error("Malformed document body.");

  const rels = await relsTargets(zip, "word/_rels/document.xml.rels");
  const imageData = new Map<string, string>();
  for (const target of rels.values()) {
    const resolved = normalizeRelTarget("word", target);
    if (!/^word\/media\//i.test(resolved)) continue;
    const file = zip.file(resolved);
    if (!file) continue;
    const b64 = await file.async("base64");
    const key = resolved;
    imageData.set(key, `data:${contentTypeFor(resolved)};base64,${b64}`);
    for (const [id, t] of rels) {
      if (normalizeRelTarget("word", t) === key) imageData.set(id, imageData.get(key)!);
    }
  }

  const defaultStyleNode =
    (first(doc.documentElement, W_NS, "docDefaults")
      ? first(first(doc.documentElement, W_NS, "docDefaults")!, W_NS, "rPrDefault")
      : null) ?? null;
  const defaultStyle = runStyleOf(defaultStyleNode ? first(defaultStyleNode, W_NS, "rPr") : null);

  const items: (WordParagraph | WordTable)[] = [];
  const collect = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (child.namespaceURI !== W_NS) continue;
      if (child.localName === "p") items.push(parseParagraph(child, imageData, defaultStyle));
      else if (child.localName === "tbl") items.push(parseTable(child, imageData, defaultStyle));
      else if (child.localName === "sdt") {
        const content = first(child, W_NS, "sdtContent");
        if (content) collect(content);
      }
    }
  };
  collect(body);

  const sectPr = first(body, W_NS, "sectPr");
  const pgSz = sectPr ? first(sectPr, W_NS, "pgSz") : null;
  const pgMar = sectPr ? first(sectPr, W_NS, "pgMar") : null;
  const pageWidth = pgSz ? attrNum(pgSz, "w", 12240) : 12240;
  const pageHeight = pgSz ? attrNum(pgSz, "h", 15840) : 15840;
  const marginLeft = pgMar ? attrNum(pgMar, "left", 1440) : 1440;
  const marginRight = pgMar ? attrNum(pgMar, "right", 1440) : 1440;
  const marginTop = pgMar ? attrNum(pgMar, "top", 1440) : 1440;
  const marginBottom = pgMar ? attrNum(pgMar, "bottom", 1440) : 1440;

  return {
    items,
    pageWidth: (pageWidth / TWIPS_PER_INCH) * PX_PER_INCH,
    pageHeight: (pageHeight / TWIPS_PER_INCH) * PX_PER_INCH,
    marginTop: (marginTop / TWIPS_PER_INCH) * PX_PER_INCH,
    marginRight: (marginRight / TWIPS_PER_INCH) * PX_PER_INCH,
    marginBottom: (marginBottom / TWIPS_PER_INCH) * PX_PER_INCH,
    marginLeft: (marginLeft / TWIPS_PER_INCH) * PX_PER_INCH,
    contentWidth: ((pageWidth - marginLeft - marginRight) / TWIPS_PER_INCH) * PX_PER_INCH
  };
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

function ptToPx(points: number, scale: number): number {
  return points * (PX_PER_INCH / 72) * scale;
}

function twipToPx(twips: number, scale: number): number {
  return (twips / TWIPS_PER_INCH) * PX_PER_INCH * scale;
}

function jcToTextAlign(jc: string): React.CSSProperties["textAlign"] {
  switch (jc) {
    case "center":
      return "center";
    case "right":
      return "right";
    case "both":
    case "distribute":
      return "justify";
    default:
      return "left";
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface DocxViewerProps {
  path: string;
  name: string;
  kind: DocumentKind;
}

export default function DocxViewer({ path, name, kind }: DocxViewerProps): React.JSX.Element {
  const { bytes, loading, failed } = useDocumentBytes(path);
  const [model, setModel] = useState<WordModel | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [containerWidth, setContainerWidth] = useState(280);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    setModel(null);
    setErrorText(null);
    const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    void (async () => {
      try {
        const zip = await JSZip.loadAsync(new Uint8Array(arrayBuffer));
        const model = await buildModel(zip, new Uint8Array(arrayBuffer));
        if (!cancelled) setModel(model);
      } catch (err) {
        if (!cancelled) setErrorText(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const update = (): void => setContainerWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const pageScale = useMemo(() => {
    if (!model) return 0;
    return Math.min(Math.max(containerWidth / 1080, 0.85), 1.45);
  }, [model, containerWidth]);

  const toolbar = (
    <>
      <span className="rounded bg-surface-container-low px-1.5 py-0.5 font-label-sm text-label-sm text-editor-text-dim">
        {model ? `${model.items.length} item${model.items.length === 1 ? "" : "s"}` : "Rendering…"}
      </span>
    </>
  );

  const showError = failed || !!errorText;

  return (
    <DocShell kind={kind} path={path} name={name} toolbar={toolbar}>
      {showError ? (
        <DocError kind={kind} path={path} message={errorText ?? undefined} onRetry={() => retryDocumentBytes(path)} />
      ) : loading || !model ? (
        <DocLoading />
      ) : (
        <div
          ref={scrollerRef}
          className="h-full w-full overflow-y-auto bg-editor-surface"
        >
          <div className="flex min-h-full justify-center px-4 py-6 lg:px-8">
            <div className="w-full max-w-[980px] rounded-lg bg-white px-8 py-10 shadow-[0_2px_18px_rgba(0,0,0,0.16)] sm:px-12">
              {model.items.map((item, itemIndex) => {
                if ("tokens" in item) {
                  return (
                    <DocumentParagraph
                      key={itemIndex}
                      paragraph={item}
                      scale={pageScale}
                    />
                  );
                }
                return (
                  <DocumentTable
                    key={itemIndex}
                    table={item}
                    scale={pageScale}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </DocShell>
  );
}

function DocumentParagraph({ paragraph, scale }: { paragraph: WordParagraph; scale: number }): React.JSX.Element {
  return (
    <p
      className="m-0"
      style={{
        textAlign: jcToTextAlign(paragraph.jc),
        textIndent: ptToPx(paragraph.indFirst, scale),
        paddingLeft: ptToPx(paragraph.indLeft, scale),
        marginTop: ptToPx(paragraph.spBeforePt, scale),
        marginBottom: ptToPx(paragraph.spAfterPt, scale),
        lineHeight: paragraph.spLine || 1.5,
        backgroundColor: paragraph.shd ?? "transparent",
        wordBreak: "break-word",
        minHeight: "1.2em"
      }}
    >
      <ParagraphTokens paragraph={paragraph} scale={scale} bullet={paragraph.bullet} />
    </p>
  );
}

function ParagraphTokens({
  paragraph,
  scale,
  bullet
}: {
  paragraph: WordParagraph;
  scale: number;
  bullet: boolean;
}): React.JSX.Element {
  return (
    <>
      {bullet && <span style={{ color: "#444" }}>•{"\u00a0"}</span>}
      {paragraph.tokens.map((token, index) => {
        if (token.kind === "image") {
          return (
            <img
              key={index}
              src={token.imageSrc}
              alt=""
              style={{
                maxWidth: "100%",
                width: Math.max((token.imageW ?? 100) * scale, 2),
                verticalAlign: "middle"
              }}
            />
          );
        }
        if (token.kind === "br") return <br key={index} />;
        if (token.kind === "tab") {
          return (
            <span key={index} style={{ display: "inline-block", width: 36 * scale }}>
              {"\u00a0"}
            </span>
          );
        }
        const styleForToken = (tok: WordToken): React.CSSProperties => {
          const s = tok.style;
          return {
            fontFamily: s.font,
            fontSize: ptToPx(s.sizePt, scale),
            fontWeight: s.bold ? 700 : 400,
            fontStyle: s.italic ? "italic" : "normal",
            textDecoration: s.underline ? "underline" : s.strike ? "line-through" : "none",
            textTransform: s.caps || s.smallCaps ? "uppercase" : "none",
            verticalAlign: s.vertAlign === "superscript" ? "super" : s.vertAlign === "subscript" ? "sub" : "baseline",
            color: s.color ?? "#000000",
            backgroundColor: s.highlight ?? "transparent"
          };
        };
        return (
          <span key={index} style={styleForToken(token)}>
            {token.text}
          </span>
        );
      })}
    </>
  );
}

function DocumentTable({ table, scale }: { table: WordTable; scale: number }): React.JSX.Element {
  const totalWidth = table.colWidths.reduce((s, c) => s + c, 0) || 1;
  return (
    <div className="my-1 overflow-x-auto">
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          {table.colWidths.map((w, i) => (
            <col key={i} style={{ width: `${(w / totalWidth) * 100}%` }} />
          ))}
        </colgroup>
        <tbody>
          {table.rows.map((row, r) => (
            <tr key={r}>
              {row.cells.map((cell, c) => (
                <td
                  key={c}
                  colSpan={cell.gridSpan}
                  style={{ border: "1px solid #a0a0a0", padding: ptToPx(2, scale), verticalAlign: "top" }}
                >
                  {cell.paragraphs.map((paragraph, paraIndex) => (
                    <p
                      key={paraIndex}
                      className="m-0"
                      style={{
                        textAlign: jcToTextAlign(paragraph.jc),
                        lineHeight: paragraph.spLine || 1.4,
                        minHeight: "1.2em"
                      }}
                    >
                      <ParagraphTokens paragraph={paragraph} scale={scale} bullet={paragraph.bullet} />
                    </p>
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}