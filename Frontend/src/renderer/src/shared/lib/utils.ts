import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "headline-sm",
            "headline-md",
            "headline-lg",
            "headline-lg-mobile",
            "body-lg",
            "body-md",
            "body-sm",
            "label-md",
            "label-sm"
          ]
        }
      ]
    }
  }
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
