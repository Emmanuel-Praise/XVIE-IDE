import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import type { DocumentKind } from "./documentKinds";
import DocShell, { DocError, DocLoading } from "./doc-shell";
import { retryDocumentBytes, useDocumentBytes } from "./useDocumentBytes";

/*
 * View-only PowerPoint renderer.
 *
 * Slides are rendered from the raw OOXML: slide size (p:sldSz), absolutely
 * positioned shapes (a:xfrm), run-level text with fonts/colors/sizes, slide
 * backgrounds, images, tables and placeholder geometry inherited from the
 * slide layout. The file is never rewritten.
 */

const P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const EMU_PER_INCH = 914400;
const PX_PER_INCH = 96;

interface Run {
  text: string;
  style: RunStyle;
}

interface RunStyle {
  font: string;
  sizePt: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  caps: boolean;
  color: string | null;
  letterSpacingPt: number;
}

interface Paragraph {
  runs: Run[];
  text: string;
  algn: string;
  bullet: boolean;
  lineSpacing: number | null;
  lineSpacingType: "pct" | "pts" | null;
  spaceBeforePt: number;
  spaceAfterPt: number;
  marL: number;
  indent: number;
  elt: Element | null;
}

interface TextGeometry {
  anchor: string;
  wrap: boolean;
  lIns: number;
  tIns: number;
  rIns: number;
  bIns: number;
  fontScale: number;
}

interface Shape {
  kind: "shape";
  x: number;
  y: number;
  cx: number;
  cy: number;
  rot: number;
  fill: string | null;
  lineColor: string | null;
  lineWidth: number;
  radius: number;
  clip: string;
  paragraphs: Paragraph[];
  geo: TextGeometry;
}

interface ImageShape {
  kind: "image";
  x: number;
  y: number;
  cx: number;
  cy: number;
  rot: number;
  src: string;
  cropL: number;
  cropT: number;
  cropR: number;
  cropB: number;
}

interface TableCell {
  paragraphs: Paragraph[];
  geo: TextGeometry;
  fill: string | null;
  colSpan: number;
  rowSpan: number;
}

interface TableShape {
  kind: "table";
  x: number;
  y: number;
  cx: number;
  cy: number;
  cols: number[];
  rows: { h: number; cells: TableCell[] }[];
}

interface SmartArtShape {
  kind: "smartart";
  x: number;
  y: number;
  cx: number;
  cy: number;
  label: string;
}

type ShapeNode = Shape | ImageShape | TableShape | SmartArtShape;

interface SlideModel {
  num: number;
  xmlPath: string;
  doc: Document;
  width: number;
  height: number;
  background: string;
  shapes: ShapeNode[];
}

interface PptxModel {
  slides: SlideModel[];
  width: number;
  height: number;
  slideCount: number;
}

interface BuildContext {
  zip: JSZip;
  fonts: { major: string; minor: string };
  scheme: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* XML helpers                                                         */
/* ------------------------------------------------------------------ */

function childrenByTag(el: Element, ns: string, local: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === local && c.namespaceURI === ns);
}

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

function parseEmu(value: string | null): number {
  const n = parseFloat(value ?? "");
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ */
/* Color + theme                                                       */
/* ------------------------------------------------------------------ */

let SCHEME: Record<string, string> = {};
let DEFAULT_FONT = "Arial";
const DEFAULT_FONT_SIZE = 18;

function colorOf(container: Element | null): string | null {
  if (!container) return null;
  const srgb = first(container, A_NS, "srgbClr");
  if (srgb) {
    const value = attr(srgb, "val") ?? "";
    return /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toLowerCase()}` : null;
  }
  const scheme = first(container, A_NS, "schemeClr");
  if (scheme) {
    const value = attr(scheme, "val") ?? "";
    return SCHEME[value] ?? null;
  }
  const sys = first(container, A_NS, "sysClr");
  if (sys) {
    const value = attr(sys, "lastClr") ?? "";
    return /^[0-9a-fA-F]{6}$/.test(value) ? `#${value.toLowerCase()}` : null;
  }
  const prst = first(container, A_NS, "prstClr");
  if (prst) {
    const names: Record<string, string> = {
      black: "#000000",
      white: "#ffffff",
      dkGray: "#3f3f3f",
      gray: "#808080",
      medGray: "#a6a6a6",
      ltGray: "#d9d9d9",
      green: "#008000",
      red: "#ff0000",
      blue: "#0000ff"
    };
    const value = attr(prst, "val") ?? "";
    return names[value] ?? null;
  }
  return null;
}

function solidColor(container: Element): string | null {
  if (first(container, A_NS, "noFill")) return "transparent";
  const solid = first(container, A_NS, "solidFill");
  if (solid) return colorOf(solid) ?? null;
  const grad = first(container, A_NS, "gradFill");
  if (grad) {
    const stop = grad.getElementsByTagNameNS(A_NS, "gs").item(0);
    return colorOf(stop);
  }
  return null;
}

async function parseTheme(zip: JSZip): Promise<{ scheme: Record<string, string>; fonts: { major: string; minor: string } }> {
  const scheme: Record<string, string> = {};
  const themePath = Object.keys(zip.files).find((p) => /^ppt\/theme\/theme\d+\.xml$/i.test(p));
  let major = "Arial";
  let minor = "Arial";
  if (themePath) {
    try {
      const file = zip.file(themePath);
      if (file) {
        const xml = await file.async("string");
        const parsed = new DOMParser().parseFromString(xml, "application/xml");
        const clrScheme = first(parsed.documentElement, A_NS, "clrScheme");
        if (clrScheme) {
          for (const child of Array.from(clrScheme.children)) {
            if (child.namespaceURI !== A_NS) continue;
            const c = colorOf(child);
            if (c) scheme[child.localName] = c;
          }
        }
        const fontScheme = first(parsed.documentElement, A_NS, "fontScheme");
        if (fontScheme) {
          const majorFont = first(fontScheme, A_NS, "majorFont");
          const minorFont = first(fontScheme, A_NS, "minorFont");
          const latinM = majorFont ? first(majorFont, A_NS, "latin") : null;
          const latinN = minorFont ? first(minorFont, A_NS, "latin") : null;
          if (latinM) major = attr(latinM, "typeface") || major;
          if (latinN) minor = attr(latinN, "typeface") || minor;
        }
      }
    } catch {
      /* theme fallback */
    }
  }
  return { scheme, fonts: { major, minor } };
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
    case "tiff":
      return "image/tiff";
    default:
      return "application/octet-stream";
  }
}

/* ------------------------------------------------------------------ */
/* Text parsing                                                        */
/* ------------------------------------------------------------------ */

function runStyleOf(rPr: Element | null): RunStyle {
  const style: RunStyle = {
    font: DEFAULT_FONT,
    sizePt: DEFAULT_FONT_SIZE,
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    caps: false,
    color: null,
    letterSpacingPt: 0
  };
  if (!rPr) return style;
  style.bold = attr(rPr, "b") === "1";
  style.italic = attr(rPr, "i") === "1";
  const u = attr(rPr, "u");
  style.underline = u !== null && u !== "none";
  style.strike = (attr(rPr, "strike") ?? "noStrike") !== "noStrike";
  style.caps = attr(rPr, "cap") === "all";
  const sz = parseFloat(attr(rPr, "sz") ?? "");
  if (Number.isFinite(sz) && sz > 0) style.sizePt = sz / 100;
  const latin = first(rPr, A_NS, "latin");
  const typeface = attr(latin, "typeface");
  if (typeface) style.font = typeface;
  const spc = parseFloat(attr(rPr, "spc") ?? "");
  if (Number.isFinite(spc)) style.letterSpacingPt = spc / 100;
  const color = solidColor(rPr);
  if (color && color !== "transparent") style.color = color;
  return style;
}

function parseParagraph(p: Element): Paragraph {
  const pPr = first(p, A_NS, "pPr");
  const algn = attr(pPr, "algn") ?? "l";
  const bullet = !!(pPr && (first(pPr, A_NS, "buChar") || first(pPr, A_NS, "buAutoNum")));

  let lineSpacing: number | null = null;
  let lineSpacingType: "pct" | "pts" | null = null;
  const lnSpc = pPr ? first(pPr, A_NS, "lnSpc") : null;
  if (lnSpc) {
    const pct = first(lnSpc, A_NS, "spcPct");
    const pts = first(lnSpc, A_NS, "spcPts");
    if (pct) {
      lineSpacing = attrNum(pct, "val", 100000) / 100000;
      lineSpacingType = "pct";
    } else if (pts) {
      lineSpacing = attrNum(pts, "val", 0) / 100;
      lineSpacingType = "pts";
    }
  }

  const runs: Run[] = [];
  const textParts: string[] = [];
  for (const child of Array.from(p.children)) {
    if (child.namespaceURI !== A_NS) continue;
    if (child.localName === "r" || child.localName === "fld") {
      const t = first(child, A_NS, "t");
      const content = t?.textContent ?? "";
      if (content) {
        const rPr = first(child, A_NS, "rPr");
        runs.push({ text: content, style: runStyleOf(rPr) });
        textParts.push(content);
      }
    } else if (child.localName === "br") {
      textParts.push("\n");
    }
  }
  const endParaRPr = first(p, A_NS, "endParaRPr");
  if (runs.length === 0 && endParaRPr) {
    // Keep the paragraph mark's formatting as a fallback display style.
    const style = runStyleOf(endParaRPr);
    runs.push({ text: "", style });
  }

  return {
    runs,
    text: textParts.join(""),
    algn,
    bullet,
    lineSpacing,
    lineSpacingType,
    spaceBeforePt: spaceOf(pPr ? first(pPr, A_NS, "spcBef") : null),
    spaceAfterPt: spaceOf(pPr ? first(pPr, A_NS, "spcAft") : null),
    marL: pPr ? attrNum(pPr, "marL", 0) : 0,
    indent: pPr ? attrNum(pPr, "indent", 0) : 0,
    elt: p
  };
}

function spaceOf(el: Element | null): number {
  if (!el) return 0;
  const pct = first(el, A_NS, "spcPct");
  const pts = first(el, A_NS, "spcPts");
  if (pct) return (attrNum(pct, "val", 100000) / 100000) * 18;
  if (pts) return attrNum(pts, "val", 0) / 100;
  return 0;
}

function parseTextBodyEl(txBody: Element): { paragraphs: Paragraph[]; geo: TextGeometry } {
  const bodyPr = first(txBody, A_NS, "bodyPr");
  const anchor = attr(bodyPr, "anchor") ?? "t";
  const wrap = (attr(bodyPr, "wrap") ?? "square") !== "none";
  const geo: TextGeometry = {
    anchor,
    wrap,
    lIns: bodyPr ? attrNum(bodyPr, "lIns", 91440) : 91440,
    tIns: bodyPr ? attrNum(bodyPr, "tIns", 45720) : 45720,
    rIns: bodyPr ? attrNum(bodyPr, "rIns", 91440) : 91440,
    bIns: bodyPr ? attrNum(bodyPr, "bIns", 45720) : 45720,
    fontScale: 1
  };
  const autofit = bodyPr ? first(bodyPr, A_NS, "normAutofit") : null;
  if (autofit) {
    const fs = attrNum(autofit, "fontScale", 100000);
    if (fs > 0) geo.fontScale = fs / 100000;
  }
  const paragraphs = childrenByTag(txBody, A_NS, "p").map(parseParagraph);
  return { paragraphs, geo };
}

/* ------------------------------------------------------------------ */
/* Geometry / shapes                                                   */
/* ------------------------------------------------------------------ */

function xfrmOf(el: Element): { x: number; y: number; cx: number; cy: number; rot: number } | null {
  const xfrm = first(el, A_NS, "xfrm");
  if (!xfrm) return null;
  const off = first(xfrm, A_NS, "off");
  const ext = first(xfrm, A_NS, "ext");
  return {
    x: off ? parseEmu(attr(off, "x")) : 0,
    y: off ? parseEmu(attr(off, "y")) : 0,
    cx: ext ? parseEmu(attr(ext, "cx")) : 0,
    cy: ext ? parseEmu(attr(ext, "cy")) : 0,
    rot: attrNum(xfrm, "rot", 0) / 60000
  };
}

function placeholderOf(sp: Element): string | null {
  const ph = first(sp, P_NS, "ph");
  return ph ? (attr(ph, "type") ?? "body") : null;
}

interface PlaceholderMeta {
  type: string;
  idx: number | null;
}

function placeholderMeta(sp: Element): PlaceholderMeta | null {
  const ph = first(sp, P_NS, "ph");
  if (!ph) return null;
  const idxRaw = attr(ph, "idx");
  const n = idxRaw !== null && idxRaw !== "" ? parseFloat(idxRaw) : NaN;
  return {
    type: attr(ph, "type") ?? "body",
    idx: idxRaw !== null && idxRaw !== "" && Number.isFinite(n) ? n : null
  };
}

function placeholderXfrm(
  doc: Document | null,
  sp: Element
): { x: number; y: number; cx: number; cy: number; rot: number } | null {
  if (!doc) return null;
  const meta = placeholderMeta(sp);
  if (!meta) return null;
  const spTree = first(doc.documentElement, P_NS, "spTree");
  if (!spTree) return null;
  const candidates = Array.from(spTree.getElementsByTagNameNS(P_NS, "sp"))
    .map((cand) => ({ cand, meta: placeholderMeta(cand) }))
    .filter((x): x is { cand: Element; meta: PlaceholderMeta } => !!x.meta);
  for (const { cand, meta: cm } of candidates) {
    if (cm.type === meta.type && cm.idx === meta.idx) return xfrmOf(cand);
  }
  for (const { cand, meta: cm } of candidates) {
    if (cm.type === meta.type) return xfrmOf(cand);
  }
  if (meta.idx !== null) {
    for (const { cand, meta: cm } of candidates) {
      if (cm.idx === meta.idx) return xfrmOf(cand);
    }
  }
  for (const { cand, meta: cm } of candidates) {
    if (cm.type === "body") return xfrmOf(cand);
  }
  return null;
}

function shapeAppearance(sp: Element): { fill: string | null; lineColor: string | null; lineWidth: number; radius: number; clip: string } {
  const spPr = first(sp, A_NS, "spPr");
  const fill = spPr ? solidColor(spPr) : null;
  const ln = spPr ? first(spPr, A_NS, "ln") : null;
  const lineColor = ln ? colorOf(ln) : null;
  const lineWidth = ln ? attrNum(ln, "w", 0) : 0;
  const prstGeom = spPr ? first(spPr, A_NS, "prstGeom") : null;
  const prst = attr(prstGeom, "prst") ?? "rect";
  let clip = "rect";
  let radius = 0;
  if (prst === "ellipse" || prst === "oval") clip = "ellipse";
  else if (prst === "roundRect") {
    clip = "roundRect";
    radius = 0.08;
  }
  if (prstGeom) {
    const adj = prstGeom.getElementsByTagNameNS(A_NS, "gd").item(0);
    if (adj) {
      const fmla = attr(adj, "fmla") ?? "";
      const value = parseFloat(fmla.replace(/^val\s+/, ""));
      if (Number.isFinite(value) && prst === "roundRect") radius = Math.min(value / 100000, 0.5);
    }
  }
  return { fill, lineColor, lineWidth, radius, clip };
}

function slideBackground(doc: Document): string | null {
  const cSld = first(doc.documentElement, P_NS, "cSld");
  if (!cSld) return null;
  const bg = first(cSld, P_NS, "bg");
  if (!bg) return null;
  const color = solidColor(bg);
  return color && color !== "transparent" ? color : null;
}

/* ------------------------------------------------------------------ */
/* Slide building                                                      */
/* ------------------------------------------------------------------ */

async function buildSlide(
  ctx: BuildContext,
  slidePath: string,
  num: number,
  width: number,
  height: number
): Promise<SlideModel> {
  const slideFile = ctx.zip.file(slidePath);
  if (!slideFile) throw new Error(`Missing slide file: ${slidePath}`);
  const xml = await slideFile.async("string");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  let background = slideBackground(doc) ?? "#ffffff";

  const slideName = slidePath.split("/").pop() ?? "";
  const rels = await relsTargets(ctx.zip, `ppt/slides/_rels/${slideName}.rels`);
  const imageData = new Map<string, string>();
  for (const target of rels.values()) {
    const resolved = normalizeRelTarget("ppt/slides", target);
    if (!/^ppt\/media\//i.test(resolved)) continue;
    const file = ctx.zip.file(resolved);
    if (!file) continue;
    const b64 = await file.async("base64");
    imageData.set(resolved, `data:${contentTypeFor(resolved)};base64,${b64}`);
  }

  let layout: Document | null = null;
  let master: Document | null = null;
  for (const target of rels.values()) {
    const resolved = normalizeRelTarget("ppt/slides", target);
    if (/^ppt\/slideLayouts\/slideLayout\d+\.xml$/i.test(resolved)) {
      const layoutFile = ctx.zip.file(resolved);
      if (layoutFile) layout = new DOMParser().parseFromString(await layoutFile.async("string"), "application/xml");
      if (layout && background === "#ffffff") background = slideBackground(layout) ?? "#ffffff";
      const layoutRels = await relsTargets(ctx.zip, `ppt/slideLayouts/_rels/${resolved.split("/").pop()}.rels`);
      for (const masterTarget of layoutRels.values()) {
        const masterResolved = normalizeRelTarget("ppt/slideLayouts", masterTarget);
        if (/^ppt\/slideMasters\/slideMaster\d+\.xml$/i.test(masterResolved)) {
          const masterFile = ctx.zip.file(masterResolved);
          if (masterFile) {
            master = new DOMParser().parseFromString(await masterFile.async("string"), "application/xml");
            if (background === "#ffffff") background = slideBackground(master) ?? "#ffffff";
          }
          break;
        }
      }
      break;
    }
  }

  const shapes: ShapeNode[] = [];
  const cSld = first(doc.documentElement, P_NS, "cSld");
  const spTree = cSld ? first(cSld, P_NS, "spTree") : null;
  if (spTree) {
    for (const node of Array.from(spTree.children)) {
      if (node.namespaceURI !== P_NS) continue;
      const nodes = await buildNode(node, 0, 0, ctx, rels, imageData, layout, master);
      shapes.push(...nodes);
    }
  }

  return { num, xmlPath: slidePath, doc, width, height, background, shapes };
}

async function buildNode(
  node: Element,
  offsetX: number,
  offsetY: number,
  ctx: BuildContext,
  rels: Map<string, string>,
  imageData: Map<string, string>,
  layout: Document | null,
  master: Document | null
): Promise<ShapeNode[]> {
  switch (node.localName) {
    case "sp": {
      const pos =
        xfrmOf(node) ??
        (placeholderOf(node) ? placeholderXfrm(layout, node) ?? placeholderXfrm(master, node) : null);
      if (!pos) return [];
      const txBody = first(node, P_NS, "txBody");
      if (!txBody) return [];
      const { paragraphs, geo } = parseTextBodyEl(txBody);
      const app = shapeAppearance(node);
      return [
        {
          kind: "shape",
          x: offsetX + pos.x,
          y: offsetY + pos.y,
          cx: pos.cx,
          cy: pos.cy,
          rot: pos.rot,
          fill: app.fill,
          lineColor: app.lineColor,
          lineWidth: app.lineWidth,
          radius: app.radius,
          clip: app.clip,
          paragraphs,
          geo
        }
      ];
    }
    case "pic": {
      const pos = xfrmOf(node);
      if (!pos) return [];
      const blip = first(node, A_NS, "blip");
      const embed = blip ? attr(blip, "embed") : null;
      const target = embed ? rels.get(embed) : null;
      const resolved = target ? normalizeRelTarget("ppt/slides", target) : null;
      const src = resolved ? imageData.get(resolved) : null;
      if (!src) return [];
      const stretch = first(node, A_NS, "stretch");
      const srcRect = stretch ? first(stretch, A_NS, "srcRect") : null;
      const cropOf = (name: string): number => {
        const value = parseFloat(attr(srcRect, name) ?? "");
        return Number.isFinite(value) ? Math.max(0, value / 1000) : 0;
      };
      return [
        {
          kind: "image",
          x: offsetX + pos.x,
          y: offsetY + pos.y,
          cx: pos.cx,
          cy: pos.cy,
          rot: pos.rot,
          src,
          cropL: cropOf("l"),
          cropT: cropOf("t"),
          cropR: cropOf("r"),
          cropB: cropOf("b")
        }
      ];
    }
    case "graphicFrame": {
      const pos = xfrmOf(node);
      if (!pos) return [];
      const graphic = first(node, A_NS, "graphic");
      const graphicData = graphic ? first(graphic, A_NS, "graphicData") : null;
      const uri = attr(graphicData, "uri") ?? "";
      if (/\/table$/.test(uri) && graphicData) {
        const tbl = first(graphicData, A_NS, "tbl");
        if (tbl) {
          const cols = Array.from(tbl.getElementsByTagNameNS(A_NS, "gridCol")).map((c) => attrNum(c, "w", 0));
          const rows = Array.from(tbl.getElementsByTagNameNS(A_NS, "tr")).map((tr) => ({
            h: attrNum(tr, "h", 0),
            cells: Array.from(tr.getElementsByTagNameNS(A_NS, "tc")).map((tc) => {
              const tcPr = first(tc, A_NS, "tcPr");
              const fill = tcPr ? solidColor(tcPr) : null;
              const txBody = first(tc, A_NS, "txBody");
              const { paragraphs, geo } = txBody
                ? parseTextBodyEl(txBody)
                : { paragraphs: [] as Paragraph[], geo: defaultGeo() };
              return {
                paragraphs,
                geo,
                fill: fill ?? null,
                colSpan: Math.max(attrNum(tc, "gridSpan", 1), 1),
                rowSpan: Math.max(attrNum(tc, "rowSpan", 1), 1)
              };
            })
          }));
          return [
            {
              kind: "table",
              x: offsetX + pos.x,
              y: offsetY + pos.y,
              cx: pos.cx,
              cy: pos.cy,
              cols,
              rows
            }
          ];
        }
      }
      if (/\/chart$/.test(uri) || /\/diagram$/.test(uri)) {
        return [
          {
            kind: "smartart" as const,
            x: offsetX + pos.x,
            y: offsetY + pos.y,
            cx: pos.cx,
            cy: pos.cy,
            label: /chart$/.test(uri) ? "Chart" : "SmartArt"
          }
        ];
      }
      return [];
    }
    case "grpSp": {
      const group = xfrmOf(node);
      const chOff = first(node, A_NS, "chOff");
      const dX = group?.x ?? 0;
      const dY = group?.y ?? 0;
      const childOffsetX = chOff ? dX + attrNum(chOff, "x", 0) : dX;
      const childOffsetY = chOff ? dY + attrNum(chOff, "y", 0) : dY;
      const result: ShapeNode[] = [];
      for (const child of Array.from(node.children)) {
        if (child.localName === "nvGrpSpPr" || child.localName === "grpSpPr") continue;
        const nodes = await buildNode(child, offsetX + childOffsetX, offsetY + childOffsetY, ctx, rels, imageData, layout, master);
        result.push(...nodes);
      }
      return result;
    }
    case "contentPart":
    case "cdrContent": {
      const pos = xfrmOf(node);
      if (!pos) return [];
      return [
        {
          kind: "smartart" as const,
          x: offsetX + pos.x,
          y: offsetY + pos.y,
          cx: pos.cx,
          cy: pos.cy,
          label: node.localName === "contentPart" ? "SmartArt" : "Diagram"
        }
      ];
    }
    default:
      return [];
  }
}

function defaultGeo(): TextGeometry {
  return { anchor: "t", wrap: true, lIns: 91440, tIns: 45720, rIns: 91440, bIns: 45720, fontScale: 1 };
}

/* ------------------------------------------------------------------ */
/* Rendering helpers                                                   */
/* ------------------------------------------------------------------ */

function px(emu: number, scale: number): number {
  return (emu / EMU_PER_INCH) * PX_PER_INCH * scale;
}

function ptToPx(points: number, scale: number): number {
  return points * (PX_PER_INCH / 72) * scale;
}

function alignValue(algn: string): React.CSSProperties["textAlign"] {
  switch (algn) {
    case "ctr":
      return "center";
    case "r":
      return "right";
    case "jstfy":
      return "justify";
    case "dist":
      return "justify";
    default:
      return "left";
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface PptxViewerProps {
  path: string;
  name: string;
  kind: DocumentKind;
}

export default function PptxViewer({ path, name, kind }: PptxViewerProps): React.JSX.Element {
  const { bytes, loading, failed } = useDocumentBytes(path);
  const [model, setModel] = useState<PptxModel | null>(null);
  const [parseFailed, setParseFailed] = useState(false);
  const [containerWidth, setContainerWidth] = useState(280);
  const [zoom, setZoom] = useState(1.15);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    setModel(null);
    setParseFailed(false);
    void (async () => {
      try {
        const zip = await JSZip.loadAsync(bytes);
        const theme = await parseTheme(zip);
        SCHEME = theme.scheme;
        DEFAULT_FONT = theme.fonts.minor;
        const { width, height } = await readSlideSize(zip);
        const paths = await readSlideOrder(zip);
        const ctx: BuildContext = { zip, fonts: theme.fonts, scheme: theme.scheme };
        const slides: SlideModel[] = [];
        for (let i = 0; i < paths.length; i++) {
          if (cancelled) return;
          slides.push(await buildSlide(ctx, paths[i], i + 1, width, height));
        }
        if (!cancelled) setModel({ slides, width, height, slideCount: paths.length });
      } catch {
        if (!cancelled) setParseFailed(true);
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

  const displayScale = useMemo(() => {
    if (!model) return 0;
    const slideWidthPx = (model.width / EMU_PER_INCH) * PX_PER_INCH;
    return (Math.max(containerWidth, 240) / slideWidthPx) * zoom;
  }, [model, containerWidth, zoom]);

  const toolbar = (
    <>
      <span className="rounded bg-surface-container-low px-1.5 py-0.5 font-label-sm text-label-sm text-editor-text-dim">
        {model ? `${model.slideCount} slide${model.slideCount === 1 ? "" : "s"}` : "Parsing…"}
      </span>
      {model ? (
        <span className="ml-2 flex items-center gap-0.5">
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-container-low font-label-sm text-label-sm text-editor-text transition-colors hover:bg-editor-text-dim/10 disabled:opacity-40"
            onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.25) * 10) / 10))}
            disabled={zoom <= 0.5}
            title="Zoom out"
          >
            −
          </button>
          <span className="w-12 text-center font-label-sm text-label-sm text-editor-text-dim">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className="flex h-6 w-6 items-center justify-center rounded-md bg-surface-container-low font-label-sm text-label-sm text-editor-text transition-colors hover:bg-editor-text-dim/10 disabled:opacity-40"
            onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.25) * 10) / 10))}
            disabled={zoom >= 4}
            title="Zoom in"
          >
            +
          </button>
        </span>
      ) : null}
    </>
  );

  const showError = failed || parseFailed;

  return (
    <DocShell kind={kind} path={path} name={name} toolbar={toolbar}>
      {showError ? (
        <DocError kind={kind} path={path} onRetry={() => retryDocumentBytes(path)} />
      ) : loading || !model ? (
        <DocLoading />
      ) : (
        <div
          ref={scrollerRef}
          className="h-full w-full overflow-auto bg-editor-surface"
        >
          <div className="mx-auto flex flex-col gap-5 px-5 py-6"
            style={{
              width: Math.max(containerWidth, ((model.width / EMU_PER_INCH) * PX_PER_INCH * displayScale) + 40),
              minWidth: Math.max(containerWidth, 240)
            }}
          >
            {model.slides.map((slide, slideIndex) => (
              <SlideCard
                key={slide.num}
                slide={slide}
                slideIndex={slideIndex}
                scale={displayScale}
              />
            ))}
          </div>
        </div>
      )}
    </DocShell>
  );
}

function SlideCard({
  slide,
  slideIndex,
  scale
}: {
  slide: SlideModel;
  slideIndex: number;
  scale: number;
}): React.JSX.Element {
  const widthPx = px(slide.width, scale);
  const heightPx = px(slide.height, scale);
  return (
    <section className="overflow-hidden rounded-xl border border-outline-variant bg-surface-container-low">
      <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container px-3 py-1.5">
        <span className="font-label-sm text-label-sm text-editor-text-dim">Slide {slideIndex + 1}</span>
        <span className="font-label-sm text-label-sm text-editor-text-dim">
          {slide.width > slide.height ? "16:9" : "4:3"}
        </span>
      </div>
      <div className="flex justify-center bg-[#d8dcdf] p-4">
        <div
          className="relative overflow-hidden shadow-[0_2px_14px_rgba(0,0,0,0.25)]"
          style={{ width: Math.round(widthPx), height: Math.round(heightPx), background: slide.background }}
        >
          {slide.shapes.map((shape, shapeIndex) => {
            const key = `${slide.num}:${shapeIndex}`;
            switch (shape.kind) {
              case "shape":
                return <ShapeBlock key={key} shape={shape} scale={scale} />;
              case "image":
                return <ImageBlock key={key} shape={shape} scale={scale} />;
              case "table":
                return <TableBlock key={key} shape={shape} scale={scale} />;
              case "smartart":
                return <SmartArtBlock key={key} shape={shape} scale={scale} />;
            }
          })}
        </div>
      </div>
    </section>
  );
}

function ShapeBlock({ shape, scale }: { shape: Shape; scale: number }): React.JSX.Element {
  const width = Math.max(px(shape.cx, scale), 1);
  const height = Math.max(px(shape.cy, scale), 1);
  const radius =
    shape.clip === "ellipse" ? "50%" : shape.clip === "roundRect" ? `${Math.max(shape.radius * width, 1)}px` : 0;
  return (
    <div
      className="absolute overflow-hidden"
      style={{
        left: px(shape.x, scale),
        top: px(shape.y, scale),
        width,
        height,
        borderRadius: radius,
        transform: shape.rot ? `rotate(${shape.rot}deg)` : undefined,
        background: shape.fill ?? "transparent",
        border: shape.lineWidth ? `${Math.max(px(shape.lineWidth, scale), 1)}px solid ${shape.lineColor ?? "transparent"}` : "none"
      }}
    >
      <div
        className="flex h-full w-full flex-col"
        style={{
          justifyContent:
            shape.geo.anchor === "ctr" ? "center" : shape.geo.anchor === "b" ? "flex-end" : "flex-start",
          paddingTop: px(shape.geo.tIns, scale),
          paddingBottom: px(shape.geo.bIns, scale),
          paddingLeft: px(shape.geo.lIns, scale),
          paddingRight: px(shape.geo.rIns, scale)
        }}
      >
        {shape.paragraphs.map((paragraph, paraIndex) => {
          return (
            <p
              key={paraIndex}
              className="m-0"
              style={{
                textAlign: alignValue(paragraph.algn),
                lineHeight: paragraph.lineSpacingType === "pct" ? (paragraph.lineSpacing ?? 1) : paragraph.lineSpacingType === "pts" ? ptToPx(paragraph.lineSpacing ?? 0, scale) : undefined,
                paddingLeft: px(paragraph.marL, scale),
                textIndent: paragraph.indent ? px(paragraph.indent, scale) : undefined,
                marginTop: ptToPx(paragraph.spaceBeforePt, scale),
                marginBottom: ptToPx(paragraph.spaceAfterPt, scale),
                whiteSpace: shape.geo.wrap ? "pre-wrap" : "pre"
              }}
            >
              <RenderedRuns paragraph={paragraph} scale={scale} fontScale={shape.geo.fontScale} />
            </p>
          );
        })}
      </div>
    </div>
  );
}

function RenderedRuns({ paragraph, scale, fontScale }: { paragraph: Paragraph; scale: number; fontScale: number }) {
  const styleFor = (run: Run): React.CSSProperties => {
    const size = Math.max(run.style.sizePt * fontScale, 1);
    return {
      fontFamily: run.style.font,
      fontSize: ptToPx(size, scale),
      fontWeight: run.style.bold ? 700 : 400,
      fontStyle: run.style.italic ? "italic" : "normal",
      textDecoration: run.style.underline ? "underline" : run.style.strike ? "line-through" : "none",
      textTransform: run.style.caps ? "uppercase" : "none",
      letterSpacing: run.style.letterSpacingPt ? ptToPx(run.style.letterSpacingPt * fontScale, scale) : undefined,
      color: run.style.color ?? "#222222"
    };
  };
  return (
    <>
      {paragraph.runs.map((run, index) => (
        <span key={index} style={styleFor(run)}>
          {run.text}
        </span>
      ))}
    </>
  );
}

function ImageBlock({ shape, scale }: { shape: ImageShape; scale: number }): React.JSX.Element {
  const width = Math.max(px(shape.cx, scale), 1);
  const height = Math.max(px(shape.cy, scale), 1);
  const visW = Math.max(1 - shape.cropL - shape.cropR, 0.02);
  const visH = Math.max(1 - shape.cropT - shape.cropB, 0.02);
  return (
    <div
      className="absolute overflow-hidden"
      style={{
        left: px(shape.x, scale),
        top: px(shape.y, scale),
        width,
        height,
        transform: shape.rot ? `rotate(${shape.rot}deg)` : undefined,
        background: "transparent"
      }}
    >
      <img
        src={shape.src}
        alt=""
        draggable={false}
        style={{
          position: "absolute",
          width: `${100 / visW}%`,
          height: `${100 / visH}%`,
          left: `${-(shape.cropL / visW) * 100}%`,
          top: `${-(shape.cropT / visH) * 100}%`
        }}
      />
    </div>
  );
}

function TableBlock({ shape, scale }: { shape: TableShape; scale: number }): React.JSX.Element {
  const totalCols = shape.cols.reduce((s, c) => s + c, 0) || 1;
  const width = Math.max(px(shape.cx, scale), 1);
  return (
    <div
      className="absolute overflow-hidden"
      style={{ left: px(shape.x, scale), top: px(shape.y, scale), width, height: Math.max(px(shape.cy, scale), 1) }}
    >
      <table style={{ width: "100%", height: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
        <colgroup>
          {shape.cols.map((w, i) => (
            <col key={i} style={{ width: `${(w / totalCols) * 100}%` }} />
          ))}
        </colgroup>
        <tbody>
          {shape.rows.map((row, r) => (
            <tr key={r} style={{ height: `${(row.h / (shape.rows.reduce((s, x) => s + x.h, 0) || 1)) * 100}%` }}>
              {row.cells.map((cell, c) => (
                <td
                  key={c}
                  colSpan={cell.colSpan}
                  rowSpan={cell.rowSpan}
                  className="p-1 align-middle"
                  style={{
                    border: "1px solid rgba(0,0,0,0.25)",
                    background: cell.fill ?? "transparent",
                    verticalAlign: cell.geo.anchor === "ctr" ? "middle" : cell.geo.anchor === "b" ? "bottom" : "top"
                  }}
                >
                  {cell.paragraphs.map((paragraph, paraIndex) => (
                    <p
                      key={paraIndex}
                      className="m-0"
                      style={{ textAlign: alignValue(paragraph.algn), whiteSpace: "pre-wrap" }}
                    >
                      <RenderedRuns paragraph={paragraph} scale={scale} fontScale={1} />
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

function SmartArtBlock({ shape, scale }: { shape: SmartArtShape; scale: number }): React.JSX.Element {
  return (
    <div
      className="absolute flex items-center justify-center overflow-hidden border border-dashed border-outline-variant"
      style={{
        left: px(shape.x, scale),
        top: px(shape.y, scale),
        width: Math.max(px(shape.cx, scale), 1),
        height: Math.max(px(shape.cy, scale), 1),
        background:
          "repeating-linear-gradient(45deg, rgba(0,0,0,0.04) 0 8px, transparent 8px 16px)"
      }}
      title={`${shape.label} — not editable in this preview`}
    >
      <span className="font-label-sm text-label-sm text-editor-text-dim">{shape.label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Presentation reading                                                */
/* ------------------------------------------------------------------ */

async function readSlideSize(zip: JSZip): Promise<{ width: number; height: number }> {
  try {
    const file = zip.file("ppt/presentation.xml");
    if (!file) return { width: 12192000, height: 6858000 };
    const doc = new DOMParser().parseFromString(await file.async("string"), "application/xml");
    const sldSz = first(doc.documentElement, P_NS, "sldSz");
    return {
      width: attrNum(sldSz, "cx", 12192000),
      height: attrNum(sldSz, "cy", 6858000)
    };
  } catch {
    return { width: 12192000, height: 6858000 };
  }
}

async function readSlideOrder(zip: JSZip): Promise<string[]> {
  try {
    const file = zip.file("ppt/presentation.xml");
    if (!file) return [];
    const doc = new DOMParser().parseFromString(await file.async("string"), "application/xml");
    const rels = await relsTargets(zip, "ppt/_rels/presentation.xml.rels");
    const ids = Array.from(doc.getElementsByTagNameNS(P_NS, "sldId"));
    const paths = ids
      .sort((a, b) => attrNum(a, "id", 0) - attrNum(b, "id", 0))
      .map((sldId) => attr(sldId, "rid") ?? attr(sldId, "r:id"))
      .filter((rid) => rid !== null)
      .map((rid) => rels.get(rid!))
      .filter((target): target is string => !!target)
      .map((target) => normalizeRelTarget("ppt", target))
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p));
    if (paths.length > 0) return paths;
  } catch {
    /* fall through */
  }
  return Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort();
}