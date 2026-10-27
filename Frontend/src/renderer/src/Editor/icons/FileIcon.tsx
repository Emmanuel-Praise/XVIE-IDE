import { ArrowUpRight } from "lucide-react";
import { folderContentBadge, folderIconFor } from "./folder-icons";
import { fileIconFor } from "./file-icons";
import { GIT_STATUS_META, type GitStatus } from "./git-status";

interface FileIconProps {
  name: string;
  path?: string;
  isDirectory?: boolean;
  open?: boolean;
  size?: number;
  gitStatus?: GitStatus | null;
  isSymlink?: boolean;
  className?: string;
  contentHints?: string[];
}

/**
 * Renders the contextual icon for any explorer entry: brand-colored file
 * icons, contextual folder icons with open/closed states, plus subtle git
 * and symlink decorations. Folders keep their folder glyph and get a small
 * badge of the dominant file inside (when content hints are provided).
 */
export default function FileIcon({
  name,
  path,
  isDirectory,
  open,
  size = 15,
  gitStatus,
  isSymlink,
  className,
  contentHints
}: FileIconProps): React.JSX.Element {
  const spec = isDirectory ? folderIconFor(name, open ?? false) : fileIconFor(name, path);
  const { Icon, color } = spec;
  const badge =
    isDirectory && contentHints && contentHints.length > 0
      ? folderContentBadge(contentHints)
      : null;
  const badgeSize = Math.max(7, Math.round(size * 0.55));
  const git = gitStatus ? GIT_STATUS_META[gitStatus] : null;

  return (
    <span
      className={`relative inline-flex shrink-0 items-center ${className ?? ""}`}
    >
      <Icon
        size={size}
        color={color}
        className="shrink-0"
        aria-hidden="true"
      />
      {badge && (
        <span className="absolute -bottom-[3px] -right-[3px] rounded-full bg-editor-surface-raised p-[1.5px]">
          <badge.Icon
            size={badgeSize}
            color={badge.color}
            className="shrink-0"
            aria-hidden="true"
          />
        </span>
      )}
      {git && (
        <span
          aria-label={git.label}
          title={git.label}
          className="ml-0.5 select-none font-label-sm text-[9px] font-bold leading-none"
          style={{ color: git.color }}
        >
          {git.letter}
        </span>
      )}
      {isSymlink && (
        <ArrowUpRight
          size={9}
          strokeWidth={2.2}
          className="ml-0.5 shrink-0"
          color="var(--outline)"
          aria-hidden="true"
        />
      )}
    </span>
  );
}
