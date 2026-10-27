import type { ComponentType } from "react";

export interface IconSpec {
  /** Lucide or Simple Icons component, both accept size/className/color. */
  Icon: ComponentType<{ size?: number | string; className?: string; color?: string }>;
  /** Brand or category color; must read on both light and dark chrome. */
  color: string;
}
