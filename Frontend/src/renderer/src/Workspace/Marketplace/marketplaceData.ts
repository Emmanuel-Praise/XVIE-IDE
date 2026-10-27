import type { LucideIcon } from "lucide-react";
import type { GitHubRepo } from "../../../../shared/ipc-types";

export const CATEGORIES = [
  "Web Development",
  "Mobile Apps",
  "AI / Machine Learning",
  "Infrastructure",
  "UI Kits"
] as const;

export type Category = (typeof CATEGORIES)[number];
export type SortKey = "popular" | "recent" | "forks";

export interface TechChip {
  label: string;
  icon?: LucideIcon;
}

export interface Maintainer {
  name: string;
  initials: string;
}

export interface MarketplaceProject {
  id: string;
  name: string;
  category: Category;
  version: string;
  description: string;
  tech: TechChip[];
  stars: string;
  starsCount?: number;
  forks: string;
  forksCount?: number;
  hoursAgo: number;
  updatedLabel: string;
  maintainer: Maintainer;
  logo: LucideIcon | string;
  secondaryAction: "Preview" | "Docs";
  repoUrl?: string;
  cloneUrl?: string;
  rawRepo?: GitHubRepo;
}

function parseCompact(value: string): number {
  const match = /^([\d.]+)([kKmM]?)$/.exec(value.trim());
  if (!match) return 0;
  const base = parseFloat(match[1]);
  if (match[2].toLowerCase() === "k") return base * 1_000;
  if (match[2].toLowerCase() === "m") return base * 1_000_000;
  return base;
}

export const sortBy: Record<SortKey, (a: MarketplaceProject, b: MarketplaceProject) => number> = {
  popular: (a, b) =>
    (b.starsCount ?? parseCompact(b.stars)) - (a.starsCount ?? parseCompact(a.stars)),
  recent: (a, b) => a.hoursAgo - b.hoursAgo,
  forks: (a, b) => (b.forksCount ?? parseCompact(b.forks)) - (a.forksCount ?? parseCompact(a.forks))
};

function formatCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(count);
}

function timeAgoLabel(pushedAt: string): { hoursAgo: number; label: string } {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(pushedAt).getTime()) / 3_600_000));
  if (hours < 1) return { hoursAgo: 0, label: "Updated just now" };
  if (hours < 24) return { hoursAgo: hours, label: `Updated ${hours} hr${hours === 1 ? "" : "s"} ago` };
  const days = Math.floor(hours / 24);
  if (days < 7) return { hoursAgo: hours, label: `Updated ${days} day${days === 1 ? "" : "s"} ago` };
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return { hoursAgo: hours, label: `Updated ${weeks} week${weeks === 1 ? "" : "s"} ago` };
  const months = Math.floor(days / 30);
  return { hoursAgo: hours, label: `Updated ${months} month${months === 1 ? "" : "s"} ago` };
}

function ownerInitials(login: string): string {
  const parts = login.split(/[-_.\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return login.slice(0, 2).toUpperCase();
}

function inferCategory(repo: GitHubRepo): Category {
  const haystack = `${repo.language ?? ""} ${(repo.topics ?? []).join(" ")}`.toLowerCase();
  const has = (pattern: RegExp): boolean => pattern.test(haystack);
  if (has(/(mobile|android|ios|flutter|react[- ]?native|kotlin|swift|expo|wearable)/)) {
    return "Mobile Apps";
  }
  if (
    has(
      /\b(ai|llm|ml|nlp|gpt|agent)\b|machine[- ]?learning|deep[- ]?learning|tensorflow|pytorch|neural/
    )
  ) {
    return "AI / Machine Learning";
  }
  if (has(/(infra|docker|kubernetes|\bk8s\b|terraform|devops|serverless|deployment|cloud)/)) {
    return "Infrastructure";
  }
  if (has(/(ui[- ]?kit|design[- ]?system|component|theming|figma)/)) {
    return "UI Kits";
  }
  return "Web Development";
}

export function mapGitHubRepo(repo: GitHubRepo): MarketplaceProject {
  const time = timeAgoLabel(repo.pushed_at ?? repo.updated_at);
  const stars = repo.stargazers_count ?? 0;
  const forks = repo.forks_count ?? 0;
  const topics = (repo.topics ?? []).slice(0, 3);
  const tech: TechChip[] =
    topics.length > 0
      ? topics.map((label) => ({ label }))
      : repo.language
        ? [{ label: repo.language }]
        : [];
  return {
    id: repo.full_name,
    name: repo.name,
    category: inferCategory(repo),
    version: repo.default_branch,
    description: repo.description ?? "No description provided.",
    tech,
    stars: formatCount(stars),
    starsCount: stars,
    forks: formatCount(forks),
    forksCount: forks,
    hoursAgo: time.hoursAgo,
    updatedLabel: time.label,
    maintainer: { name: repo.owner.login, initials: ownerInitials(repo.owner.login) },
    logo: repo.owner.avatar_url,
    secondaryAction: "Preview",
    repoUrl: repo.html_url,
    cloneUrl: repo.clone_url,
    rawRepo: repo
  };
}
