import { ChevronRight, Search, X } from "lucide-react";
import { searchResults } from "@/Editor/data/mockTerminal";
import { useEditorStore } from "@/Editor/editorStore";
import PanelShell from "@/Editor/LeftSide/panels/panel-shell";

export default function SearchPanel(): React.JSX.Element {
  const openFile = useEditorStore((state) => state.openFile);
  const query = useEditorStore((state) => state.searchQuery);
  const setQuery = useEditorStore((state) => state.setSearchQuery);

  const results = query.trim()
    ? searchResults.filter((result) =>
        `${result.path} ${result.snippet}`.toLowerCase().includes(query.toLowerCase())
      )
    : searchResults;

  return (
    <PanelShell
      title="Search"
      footer={
        <div className="flex items-center gap-1.5 px-3 py-1.5">
          <span className="font-label-sm text-label-sm text-on-surface-variant">
            {results.length} results in {new Set(results.map((r) => r.path)).size} files
          </span>
        </div>
      }
    >
      <div className="p-3">
        <div className="flex items-center gap-2 rounded-xl border border-outline-variant bg-surface-container-low px-3 py-1.5 transition-colors focus-within:border-primary">
          <Search size={13} className="shrink-0 text-secondary" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search in workspace"
            className="w-full bg-transparent font-label-md text-label-md text-on-surface placeholder-secondary focus:outline-none"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear"
              onClick={() => setQuery("")}
              className="cursor-pointer rounded p-0.5 text-secondary hover:text-primary"
            >
              <X size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-col px-1 pb-2">
        {results.map((result) => {
          const pathParts = result.path.split("/");
          return (
            <button
              key={`${result.path}-${result.line}`}
              type="button"
              onClick={() => openFile(result.path)}
              className="cursor-pointer rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-container-low"
            >
              <div className="flex items-center gap-1 font-label-sm text-label-sm text-secondary">
                <span>{pathParts[pathParts.length - 1]}</span>
                <span className="text-on-tertiary-container">:</span>
                <span className="text-on-tertiary-container">{result.line}</span>
                <ChevronRight size={12} className="ml-auto text-on-tertiary-container" />
              </div>
              <div className="truncate pl-3 font-label-md text-label-md text-on-surface">
                {result.snippet}
              </div>
            </button>
          );
        })}
        {results.length === 0 && (
          <p className="px-2 py-4 text-center font-body-sm text-body-sm text-secondary">
            No results for &quot;{query}&quot;
          </p>
        )}
      </div>
    </PanelShell>
  );
}
