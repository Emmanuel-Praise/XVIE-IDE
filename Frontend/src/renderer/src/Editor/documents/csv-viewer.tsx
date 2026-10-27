import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Table2 } from "lucide-react";
import { useEditorStore } from "@/Editor/editorStore";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";

/*
 * Editable CSV/TSV grid.
 *
 * The grid is the source of truth while a file is open; the `content` prop
 * seeds it once on mount (the component is keyed by path). Every cell change
 * flows through the same pipe as the Monaco editor (setFileContent +
 * autosave), so the tab's dirty dot, Cmd+S and autosave all keep working.
 * The delimiter (comma / semicolon / tab / pipe) and the original line ending
 * are detected on load and reused when serializing; fields containing the
 * delimiter, quotes or newlines are always re-quoted on save.
 */

interface CsvViewerProps {
  path: string;
  name: string;
  content: string;
}

interface ParsedCsv {
  rows: (string | null)[][];
  delimiter: string;
  eol: string;
}

const EOL = { CRLF: "\r\n", LF: "\n" } as const;

function parseCsv(text: string): ParsedCsv {
  const source = text.startsWith("\ufeff") ? text.slice(1) : text;
  const eol = source.includes("\r\n") ? EOL.CRLF : EOL.LF;
  const sample = source.split(/\r?\n/).slice(0, 8).join("\t");

  const counts: [string, number][] = [
    [",", (sample.match(/,/g) ?? []).length],
    [";", (sample.match(/;/g) ?? []).length],
    ["\t", (sample.match(/\t/g) ?? []).length],
    ["|", (sample.match(/\|/g) ?? []).length]
  ];
  counts.sort((a, b) => b[1] - a[1]);
  const delimiter = counts[0][1] > 0 ? counts[0][0] : ",";

  const rows: (string | null)[][] = [];
  let field = "";
  let row: (string | null)[] = [];
  let inQuotes = false;
  const flushField = (): void => {
    row.push(field === "" ? null : field);
    field = "";
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      flushField();
    } else if (ch === "\n") {
      flushField();
      rows.push(row);
      row = [];
    } else if (ch === "\r") {
      // swallowed by the \n branch
    } else {
      field += ch;
    }
  }
  flushField();
  rows.push(row);

  const maxCols = rows.reduce((max, r) => Math.max(max, r.length), 0);
  for (const r of rows) {
    while (r.length < maxCols) r.push(null);
  }
  return { rows, delimiter, eol };
}

function escapeCell(value: string, delimiter: string): string {
  if (value.includes('"') || value.includes(delimiter) || /[\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function serializeCsv(parsed: ParsedCsv): string {
  return parsed.rows
    .map((row) => row.map((cell) => escapeCell(cell ?? "", parsed.delimiter)).join(parsed.delimiter))
    .join(parsed.eol);
}

const MAX_DISPLAY_ROWS = 2000;
const MAX_COLS = 200;

export default function CsvViewer({ path, name, content }: CsvViewerProps): React.JSX.Element {
  const [parsed, setParsed] = useState<ParsedCsv>(() => parseCsv(content));
  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    if (!active) return;
    inputRefs.current[`${active.r}:${active.c}`]?.focus();
  }, [active]);

  const visibleRows = useMemo(() => parsed.rows.slice(0, MAX_DISPLAY_ROWS), [parsed]);
  const truncatedRows = parsed.rows.length > MAX_DISPLAY_ROWS;
  const colCount = useMemo(() => {
    let max = 0;
    for (const row of visibleRows) max = Math.max(max, row.length);
    return Math.min(Math.max(max, 1), MAX_COLS);
  }, [visibleRows]);

  const deltaLabel =
    parsed.delimiter === "\t" ? "tab" : parsed.delimiter === "|" ? "pipe" : parsed.delimiter;

  const commitCell = (r: number, c: number, value: string): void => {
    const current = parsed;
    const before = current.rows[r]?.[c] ?? "";
    if (before === value) return;
    const rows = current.rows.map((row, ri) =>
      ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row
    );
    const nextParsed: ParsedCsv = { ...current, rows };
    setParsed(nextParsed);
    const csvText = serializeCsv(nextParsed);
    useEditorStore.getState().setFileContent(path, csvText);
    void useEditorStore.getState().autosave(path);
  };

  const reload = async (): Promise<void> => {
    const api = window.api?.workspace;
    if (!api) return;
    try {
      const result = await api.readFile(path);
      if (!result || result.binary) return;
      useFileSystemStore.setState((state) => ({
        fileCache: { ...state.fileCache, [path]: result }
      }));
      useEditorStore.setState((state) => ({
        files: {
          ...state.files,
          [path]: {
            ...state.files[path],
            content: result.content,
            dirty: false
          }
        }
      }));
      setParsed(parseCsv(result.content));
      setActive(null);
    } catch {
      // ignore read failures on reload
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-editor-surface">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-outline-variant px-2">
        <Table2 size={14} className="shrink-0 text-primary" />
        <span className="max-w-[40%] truncate font-label-sm text-label-sm text-editor-text">{name}</span>
        <span className="shrink-0 rounded bg-surface-container-low px-1.5 py-0.5 font-label-sm text-label-sm text-editor-text-dim">
          {parsed.rows.length.toLocaleString()} × {colCount.toLocaleString()}
        </span>
        <span className="shrink-0 rounded bg-surface-container-low px-1.5 py-0.5 font-label-sm text-label-sm text-editor-text-dim">
          {deltaLabel}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            title="Reload from disk"
            onClick={() => void reload()}
            className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-label-sm text-label-sm text-editor-text transition-colors hover:bg-primary/10"
          >
            <RotateCcw size={12} />
            Reload
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table
          className="w-full border-collapse font-body-sm text-body-sm text-editor-text"
          style={{ tableLayout: "fixed", minWidth: "100%" }}
        >
          <colgroup>
            <col style={{ width: 44 }} />
            {Array.from({ length: colCount }, (_, i) => (
              <col key={i} style={{ width: 160 }} />
            ))}
          </colgroup>
          <tbody>
            {visibleRows.map((row, r) => (
              <tr key={r} className="border-b border-outline-variant/40 hover:bg-surface-container-low/50">
                <td className="sticky left-0 select-none border-r border-outline-variant/40 bg-editor-surface px-2 text-right font-label-sm text-label-sm text-editor-text-dim">
                  {r + 1}
                </td>
                {Array.from({ length: colCount }, (_, c) => {
                  const isActive = active?.r === r && active?.c === c;
                  return (
                    <td key={c} className="border-r border-outline-variant/40 last:border-r-0">
                      <input
                        ref={(el) => {
                          inputRefs.current[`${r}:${c}`] = el;
                        }}
                        value={row[c] ?? ""}
                        onChange={(e) => commitCell(r, c, e.target.value)}
                        onClick={(e) => {
                          if (!isActive) e.currentTarget.select();
                          setActive({ r, c });
                        }}
                        onFocus={() => setActive({ r, c })}
                        onBlur={() => setActive(null)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            setActive({ r: Math.min(r + 1, visibleRows.length - 1), c });
                          } else if (e.key === "Tab") {
                            setActive({ r, c: Math.min(c + 1, colCount - 1) });
                          } else if (e.key === "Escape") {
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                        className="w-full cursor-text select-none bg-transparent px-2 py-0.5 text-body-sm text-editor-text outline-none placeholder:text-editor-text-dim focus:bg-primary/10"
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {truncatedRows && (
          <div className="sticky bottom-0 flex items-center justify-center gap-2 border-t border-outline-variant/40 bg-surface-container-low px-3 py-2">
            <span className="font-label-sm text-label-sm text-editor-text-dim">
              Showing the first {MAX_DISPLAY_ROWS.toLocaleString()} of{" "}
              {parsed.rows.length.toLocaleString()} rows. The grid is display-limited only;
              full data is written back on save.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}