import { type LucideIcon } from "lucide-react";
import { Button } from "@/shared/components/button";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  actionLabel?: string;
  actionIcon?: LucideIcon;
  onAction?: () => void;
}

export default function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionIcon: ActionIcon,
  onAction
}: EmptyStateProps): React.JSX.Element {
  return (
    <div className="flex w-full flex-col items-center justify-center rounded-2xl border border-dashed border-outline-variant/40 bg-surface-container-low/30 px-lg py-2xl text-center">
      <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-surface-container to-surface-container-high">
        <Icon size={28} strokeWidth={1.5} className="text-secondary/70" />
      </div>
      <h3 className="font-headline-sm text-headline-sm text-primary">{title}</h3>
      <p className="mt-sm text-body-sm text-secondary/70 leading-relaxed">
        {description}
      </p>
      {actionLabel && (
        <Button variant="default" className="mt-lg" onClick={onAction}>
          {ActionIcon && <ActionIcon size={15} strokeWidth={2} />}
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
