import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark, oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Check, Copy } from "lucide-react";
import { useThemeStore } from "@/theme/themeStore";
import "./markdown-preview.css";

interface MarkdownPreviewProps {
  content: string;
}

function CodeBlock({ code, language }: { code: string; language: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const themeMode = useThemeStore((state) => state.mode);

  const handleCopy = (): void => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="group relative">
      {language && (
        <div className="flex items-center justify-between border-b border-outline-variant bg-surface-container-low px-3 py-1.5">
          <span className="font-label-sm text-label-sm uppercase tracking-wide text-on-surface-variant">
            {language}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy code"
            className="cursor-pointer rounded p-1 text-secondary transition-colors hover:bg-surface-container-high hover:text-primary"
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
      )}
      <SyntaxHighlighter
        language={language || "text"}
        style={themeMode === "dark" ? oneDark : oneLight}
        customStyle={{
          margin: 0,
          background: "transparent",
          fontSize: "0.8125rem",
          padding: "1em 1.1em"
        }}
        codeTagProps={{ style: { fontFamily: "var(--font-label-sm), 'JetBrains Mono Variable', monospace" } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

export default function MarkdownPreview({ content }: MarkdownPreviewProps): React.JSX.Element {
  const components = useMemo(
    () => ({
      code(props: { className?: string; children?: React.ReactNode; node?: unknown }): React.JSX.Element {
        const { className, children } = props;
        const match = /language-(\w+)/.exec(className ?? "");
        const text = String(children ?? "");
        const isBlock = text.includes("\n") || className?.includes("language-");
        if (isBlock) {
          return <CodeBlock code={text.replace(/\n$/, "")} language={match?.[1] ?? ""} />;
        }
        return <code className={className}>{children}</code>;
      }
    }),
    []
  );

  return (
    <div className="md-preview">
      <div className="md-preview__scroll">
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
