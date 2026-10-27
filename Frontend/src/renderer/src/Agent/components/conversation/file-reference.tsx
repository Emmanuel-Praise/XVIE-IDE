import { FileText } from "lucide-react";
import type { MessageFileRef } from "../../types";

export default function FileReference({ refs }: { refs: MessageFileRef[] }) {
  if (refs.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 pl-1 pt-0.5">
      {refs.map((ref) => (
        <span
          key={ref.path}
          className="inline-flex items-center gap-1.5 rounded-lg border border-outline-variant bg-surface-container-low px-2.5 py-1 font-label-xs text-label-xs text-on-surface transition-colors hover:bg-surface-container-high"
        >
          <FileText size={12} className="shrink-0 text-primary" />
          {ref.label}
        </span>
      ))}
    </div>
  );
}
