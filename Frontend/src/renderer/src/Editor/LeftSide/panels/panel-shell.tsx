import type { ReactNode } from "react";

interface PanelShellProps {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export default function PanelShell({
  title,
  actions,
  children,
  footer
}: PanelShellProps): React.JSX.Element {
  return (
    <div className="flex h-full w-full shrink-0 flex-col overflow-hidden rounded-r-2xl border-r border-outline-variant bg-surface-container-lowest">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-outline-variant px-3">
        <h2 className="font-label-md text-label-md font-bold uppercase tracking-wider text-on-surface">
          {title}
        </h2>
        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
      <div className="agent-code-scroll min-h-0 flex-1 overflow-y-scroll overscroll-contain">{children}</div>
      {footer && (
        <div className="shrink-0 border-t border-outline-variant">{footer}</div>
      )}
    </div>
  );
}
