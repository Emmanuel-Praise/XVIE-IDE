import { type HTMLAttributes, forwardRef } from "react";
import { cn } from "@/shared/lib/utils";

const PageLayout = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <main
      ref={ref}
      className={cn(
        "flex h-full w-full flex-col items-center justify-center px-margin-mobile md:px-margin-desktop",
        className
      )}
      {...props}
    />
  )
);
PageLayout.displayName = "PageLayout";

export { PageLayout };
