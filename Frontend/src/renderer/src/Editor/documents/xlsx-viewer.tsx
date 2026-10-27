import { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";
import { Check, LockKeyhole, Save } from "lucide-react";
import type { DocumentKind } from "./documentKinds";
import { documentKindLabel, isLegacyFormat } from "./documentKinds";
import DocShell, { DocError, DocLoading } from "./doc-shell";
import { retryDocumentBytes, useDocumentBytes } from "./useDocumentBytes";
import { useFileSystemStore } from "@/Editor/fs/fileSystemStore";

interface XlsxViewerProps {
  path: string;
  name: string;
  kind: DocumentKind;
}

type CellValue = string | number | boolean | Date | null;

const MAX_ROWS = 200;
const MAX_COLS = 50;

function cellKey(r: number, c: number): string {
  return `${r}:${c}`;
}

function colLabel(index: number): string {
  let label = "";
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function displayValue(value: CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    return value.toLocaleDateString(undefined, { dateStyle: "medium" });
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value);
}

export default function XlsxViewer({ path, name, kind }: XlsxViewerProps): React.JSX.Element {
  const { bytes, loading, failed } = useDocumentBytes(path);
  const legacy = isLegacyFormat(path);
  const editable = kind === "excel" && !legacy;

  const workbookRef = useRef<XLSX.WorkBook | null>(null);
  const [grids, setGrids] = useState<Record<string, CellValue[][]>>({});
  const [sheets, setSheets] = useState<string[]>([]);
  const [activeSheet, setActiveSheet] = useState<string>("");
  const [parseFailed, setParseFailed] = useState(false);

  const [active, setActive] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useEffect(() => {
    if (!bytes) return;
    try {
      const wb = XLSX.read(bytes, { type: "array", cellDates: true });
      workbookRef.current = wb;
      const sheetNames = wb.SheetNames ?? [];
      setSheets(sheetNames);
      const next: Record<string, CellValue[][]> = {};
      let clipped = false;
      for (const nameOf of sheetNames) {
        const ws = wb.Sheets[nameOf];
        const rawRows = XLSX.utils.sheet_to_json<CellValue[]>(ws, {
          header: 1,
          defval: null,
          raw: true
        });
        if (rawRows.length > MAX_ROWS) clipped = true;
        if (rawRows.some((row) => row.length > MAX_COLS)) clipped = true;
        const trimmed = rawRows.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLS));
        const width = Math.max(...trimmed.map((row) => row.length), 1);
        for (const row of trimmed) {
          if (row.length < width) {
            for (let i = row.length; i < width; i++) row[i] = null;
          }
        }
        next[nameOf] = trimmed;
      }
      setTruncated(clipped);
      setGrids(next);
      setActiveSheet(sheetNames[0] ?? "");
      setActive(null);
      setEditing(false);
      setDirty(false);
      setParseFailed(false);
    } catch {
      setParseFailed(true);
    }
  }, [bytes]);

  const grid = grids[activeSheet] ?? [];
  const numCols = useMemo(
    () => (grids[activeSheet] ?? []).reduce((max, row) => Math.max(max, row.length), 1),
    [grids, activeSheet]
  );

  const setCell = (r: number, c: number, value: CellValue): void => {
    if (!editable) return;
    setGrids((prev) => {
      const sheet = grids[activeSheet] ?? [];
      const next = sheet.map((row, ri) =>
        ri === r ? row.map((cell, ci) => (ci === c ? value : cell)) : row
      );
      return { ...prev, [activeSheet]: next };
    });
    setDirty(true);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>, r: number, c: number): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setActive({ r, c });
      setEditing(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      setActive({ r: r + 1, c });
      setEditing(false);
    } else if (event.key === "Tab") {
      event.preventDefault();
      setActive({ r, c: c + 1 });
      setEditing(false);
    }
  };

  const commitSave = async (): Promise<void> => {
    if (!editable || !workbookRef.current || saving) return;
    setSaving(true);
    try {
      const wb = workbookRef.current;
      const ws = XLSX.utils.aoa_to_sheet(grid, { cellDates: true });
      wb.Sheets[activeSheet] = ws;
      const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true });
      const written = new Uint8Array(out);
      const result = await window.api.workspace.writeBinary(path, written);
      if (result.success) {
        useFileSystemStore.getState().invalidateBinary(path);
        setDirty(false);
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2000);
      } else {
        setParseFailed(true);
      }
    } catch {
      setParseFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const focused = active !== null && editing;

  const toolbar = (
    <>
      {!editable && (
        <span
          title="Legacy format — view only"
          className="flex items-center gap-1 rounded bg-surface-container-low px-1.5 py-0.5 font-label-sm text-label-sm text-editor-text-dim"
        >
          <LockKeyhole size={11} /> Read-only
        </span>
      )}
      {editable && (
        <button
          type="button"
          disabled={!dirty || saving}
          onClick={() => void commitSave()}
          title={dirty ? "Save changes" : "No changes yet"}
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 font-label-sm text-label-sm text-primary transition-colors hover:bg-primary/10 disabled:cursor-default disabled:opacity-40"
        >
          {savedFlash ? <Check size={12} /> : <Save size={12} />}
          {saving ? "Saving…" : savedFlash ? "Saved" : "Save"}
        </button>
      )}
      <span className="rounded bg-surface-container-low px-1.5 py-0.5 font-label-sm text-label-sm text-editor-text-dim">
        {documentKindLabel(kind)}
      </span>
    </>
  );

  const showError = failed || parseFailed;

  return (
    <DocShell kind={kind} path={path} name={name} toolbar={toolbar}>
      {showError ? (
        <DocError kind={kind} path={path} onRetry={() => retryDocumentBytes(path)} />
      ) : loading || !bytes || !grids[activeSheet] ? (
        <DocLoading />
      ) : (
        <div className="flex h-full w-full flex-col bg-editor-surface">
          {sheets.length > 1 && (
            <div className="flex h-8 shrink-0 items-end gap-1 border-b border-outline-variant px-2">
              {sheets.map((sheetName) => (
                <button
                  key={sheetName}
                  type="button"
                  onClick={() => {
                    setActiveSheet(sheetName);
                    setActive(null);
                    setEditing(false);
                  }}
                  title={sheetName}
                  className={`h-full cursor-pointer truncate border-b-2 px-3 font-label-sm text-label-sm transition-colors ${
                    sheetName === activeSheet
                      ? "border-primary font-medium text-editor-text"
                      : "border-transparent text-editor-text-dim hover:bg-surface-container-low hover:text-editor-text"
                  }`}
                >
                  {sheetName}
                </button>
              ))}
            </div>
          )}
          {truncated && (
            <div className="shrink-0 border-b border-outline-variant bg-surface-container-low px-3 py-1 font-label-sm text-label-sm text-editor-text-dim">
              Preview limited to the first {MAX_ROWS} rows × {MAX_COLS} columns — open in Excel to edit the rest.
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-auto">
            <table
              className="border-separate border-spacing-0"
              onMouseDown={() => {
                if (!editing) setEditing(false);
              }}
            >
              <thead>
                <tr>
                  <th className="sticky left-0 top-0 z-20 h-7 min-w-8 border-b border-r border-outline-variant bg-surface-container-low text-center font-label-sm text-label-sm text-editor-text-dim">
                    #
                  </th>
                  {Array.from({ length: numCols }, (_, c) => (
                    <th
                      key={c}
                      className="sticky top-0 z-10 h-7 min-w-[7.5rem] border-b border-r border-outline-variant bg-surface-container-low px-1.5 text-left font-label-sm text-label-sm text-editor-text-dim"
                    >
                      {colLabel(c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.map((row, r) => (
                  <tr key={r} className="group">
                    <td className="sticky left-0 z-10 h-7 min-w-8 border-b border-r border-outline-variant bg-surface-container text-center font-label-sm text-label-sm text-editor-text-dim">
                      {r + 1}
                    </td>
                    {Array.from({ length: numCols }, (_, c) => {
                      const value = row[c];
                      const isActive = active?.r === r && active?.c === c;
                      const isNumber = typeof value === "number";
                      return (
                        <td
                          key={cellKey(r, c)}
                          onClick={() => setActive({ r, c })}
                          onDoubleClick={() => {
                            setActive({ r, c });
                            setEditing(true);
                          }}
                          className={`h-7 border-b border-r border-outline-variant px-1.5 font-editor-mono text-[13px] leading-7 transition-colors ${isNumber ? "text-right" : "text-left"} ${
                            isActive ? "bg-primary/10" : "bg-editor-surface group-hover:bg-editor-surface-raised"
                          }`}
                        >
                          {isActive && focused ? (
                            <input
                              autoFocus
                              defaultValue={displayValue(value)}
                              onClick={(e) => e.stopPropagation()}
                              onFocus={(e) => e.currentTarget.select()}
                              onChange={(e) => setCell(r, c, e.target.value)}
                              onKeyDown={(e) => handleKeyDown(e, r, c)}
                              className="w-full min-w-0 border-0 bg-transparent py-0 font-editor-mono text-[13px] text-editor-text"
                              style={{ outline: "1px solid var(--primary)" }}
                            />
                          ) : (
                            <span className="block truncate text-editor-text">{displayValue(value)}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </DocShell>
  );
}