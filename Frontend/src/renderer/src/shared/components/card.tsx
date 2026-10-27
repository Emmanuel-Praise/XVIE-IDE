import { type HTMLAttributes, forwardRef } from "react";
import { cn } from "@/shared/lib/utils";

const Card = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        "rounded-xl border border-outline-variant/60 bg-surface-container-lowest",
        className
      )}
      {...props}
    />
  )
);
Card.displayName = "Card";

export { Card };
