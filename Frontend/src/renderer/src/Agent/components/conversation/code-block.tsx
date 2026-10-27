import { useState } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Copy, Check, ChevronDown } from "lucide-react";

interface CodeBlockProps {
  language: string;
  value: string;
}

export default function CodeBlock({ language, value }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group/code relative my-2 overflow-hidden rounded-lg border border-outline-variant/70">
      <div className="flex items-center justify-between bg-surface-container-low px-2.5 py-1">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left font-label-xs text-label-xs text-secondary hover:text-on-surface">
          <ChevronDown size={12} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
          <span>{language}</span><span className="truncate opacity-70">{value.split("\n").length} lines · {open ? "Hide code" : "Show code"}</span>
        </button>
        <button type="button" onClick={handleCopy} aria-label="Copy code" className="ml-2 cursor-pointer rounded p-1 text-secondary transition-colors hover:bg-surface-container-high hover:text-on-surface">
          {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
        </button>
      </div>
      {open && <SyntaxHighlighter
        language={language}
        style={oneDark}
        customStyle={{
          margin: 0,
          padding: "0.75rem 1rem",
          background: "transparent",
          fontSize: "12px",
          lineHeight: "1.55",
          maxHeight: "360px",
          overflow: "auto"
        }}
        codeTagProps={{
          className: "agent-code-scroll"
        }}
      >
        {value}
      </SyntaxHighlighter>}
    </div>
  );
}
