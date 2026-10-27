import { usePreviewImage } from "@/Workspace/Marketplace/repoPreview";
import type { GitHubRepo } from "../../../../shared/ipc-types";

interface Props {
  repo: GitHubRepo | undefined | null;
  alt: string;
  className?: string;
  eager?: boolean;
}

/**
 * Fast lazy preview image with skeleton shimmer.
 * Returns null while loading (caller shows skeleton) or when no preview exists
 * (caller shows its category fallback) — renders <img> only on a real URL.
 */
export default function RepoPreviewImage({ repo, alt, className, eager = false }: Props): React.JSX.Element | null {
  const preview = usePreviewImage(repo ?? undefined);
  if (preview === undefined) return null; // loading → caller skeleton
  if (preview === null) return null; // none → caller fallback
  return (
    <img
      src={preview}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      draggable={false}
      onError={(e) => {
        // Broken remote image: drop the element so the fallback shows.
        e.currentTarget.style.display = "none";
      }}
      className={className}
    />
  );
}
