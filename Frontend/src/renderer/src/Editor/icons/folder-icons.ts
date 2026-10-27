import { Boxes,
  Folder,
  FolderArchive,
  FolderCheck,
  FolderCode,
  FolderCog,
  FolderGit2,
  FolderHeart,
  FolderInput,
  FolderKey,
  FolderLock,
  FolderOpen,
  FolderOutput,
  FolderSearch,
  FolderSync,
  FolderTree
} from "lucide-react";
import { FILE_DEFAULT, fileIconFor } from "./file-icons";
import type { IconSpec } from "./types";

const spec = (Icon: IconSpec["Icon"], color: string): IconSpec => ({ Icon, color });

interface FolderSpec {
  closed: IconSpec;
  open: IconSpec;
}

const folder = (Icon: IconSpec["Icon"], color: string, OpenIcon?: IconSpec["Icon"]): FolderSpec => ({
  closed: spec(Icon, color),
  open: spec(OpenIcon ?? FolderOpen, color)
});

const FOLDER_SPECS: Record<string, FolderSpec> = {
  ".git": folder(FolderGit2, "#EF5350"),
  ".github": folder(FolderGit2, "#7986CB"),
  ".vscode": folder(FolderCog, "#007ACC"),
  ".idea": folder(FolderCog, "#FF6C3D"),
  ".config": folder(FolderCog, "#90A4AE"),

  src: folder(FolderCode, "#E8A33D"),
  lib: folder(FolderCode, "#A1887F"),
  utils: folder(FolderCode, "#A1887F"),
  util: folder(FolderCode, "#A1887F"),
  core: folder(FolderCode, "#4DB6AC"),
  shared: folder(FolderCode, "#4DB6AC"),

  public: folder(FolderHeart, "#4FC3F7"),
  static: folder(FolderHeart, "#4FC3F7"),
  assets: folder(FolderHeart, "#F06292"),
  images: folder(FolderHeart, "#F06292"),
  img: folder(FolderHeart, "#F06292"),
  icons: folder(FolderHeart, "#F06292"),
  fonts: folder(FolderHeart, "#7E57C2"),
  media: folder(FolderHeart, "#F06292"),

  components: folder(FolderCode, "#64B5F6"),
  component: folder(FolderCode, "#64B5F6"),
  ui: folder(FolderCode, "#64B5F6"),
  widgets: folder(FolderCode, "#64B5F6"),

  hooks: folder(FolderCode, "#BA68C8"),
  hook: folder(FolderCode, "#BA68C8"),
  composables: folder(FolderCode, "#BA68C8"),

  services: folder(FolderCog, "#81C784"),
  service: folder(FolderCog, "#81C784"),
  providers: folder(FolderCog, "#81C784"),
  middlewares: folder(FolderCog, "#81C784"),

  pages: folder(FolderOpen, "#FFD54F"),
  page: folder(FolderOpen, "#FFD54F"),
  views: folder(FolderOpen, "#FFD54F"),
  screens: folder(FolderOpen, "#FFD54F"),

  api: folder(FolderInput, "#4DB6AC"),
  controllers: folder(FolderCog, "#4DB6AC"),
  routes: folder(FolderInput, "#4FC3F7"),
  router: folder(FolderInput, "#4FC3F7"),
  handlers: folder(FolderCog, "#4DB6AC"),

  config: folder(FolderCog, "#90A4AE"),
  configuration: folder(FolderCog, "#90A4AE"),
  settings: folder(FolderCog, "#90A4AE"),

  database: folder(FolderTree, "#4DB6AC"),
  db: folder(FolderTree, "#4DB6AC"),
  data: folder(FolderTree, "#5C6BC0"),
  migrations: folder(FolderTree, "#FF8A65"),
  migration: folder(FolderTree, "#FF8A65"),

  tests: folder(FolderCheck, "#A5D6A7"),
  test: folder(FolderCheck, "#A5D6A7"),
  __tests__: folder(FolderCheck, "#A5D6A7"),
  e2e: folder(FolderCheck, "#FF8A80"),
  fixtures: folder(FolderCheck, "#FF8A80"),
  mocks: folder(FolderCheck, "#FF8A80"),

  docs: folder(FolderOpen, "#78909C"),
  doc: folder(FolderOpen, "#78909C"),
  documentation: folder(FolderOpen, "#78909C"),

  scripts: folder(FolderCode, "#FFB74D"),
  script: folder(FolderCode, "#FFB74D"),
  bin: folder(FolderCode, "#FFB74D"),

  build: folder(FolderOutput, "#EF5350"),
  dist: folder(FolderOutput, "#EF5350"),
  out: folder(FolderOutput, "#EF5350"),
  release: folder(FolderOutput, "#EF5350"),

  node_modules: folder(Boxes, "#90A4AE"),
  vendor: folder(Boxes, "#90A4AE"),
  packages: folder(Boxes, "#90A4AE"),
  package: folder(Boxes, "#90A4AE"),

  store: folder(FolderHeart, "#F06292"),
  stores: folder(FolderHeart, "#F06292"),
  state: folder(FolderHeart, "#F06292"),

  styles: folder(FolderCog, "#42A5F5"),
  style: folder(FolderCog, "#42A5F5"),
  css: folder(FolderCog, "#42A5F5"),
  theme: folder(FolderCog, "#42A5F5"),
  themes: folder(FolderCog, "#42A5F5"),

  types: folder(FolderCog, "#7986CB"),
  type: folder(FolderCog, "#7986CB"),
  interfaces: folder(FolderCog, "#7986CB"),
  models: folder(FolderCog, "#7986CB"),

  constants: folder(FolderCog, "#FFD54F"),
  constant: folder(FolderCog, "#FFD54F"),
  enums: folder(FolderCog, "#FFD54F"),
  enum: folder(FolderCog, "#FFD54F"),

  locales: folder(FolderHeart, "#FFD54F"),
  i18n: folder(FolderHeart, "#FFD54F"),
  translations: folder(FolderHeart, "#FFD54F"),
  lang: folder(FolderHeart, "#FFD54F"),

  backend: folder(FolderCog, "#66BB6A"),
  server: folder(FolderCog, "#66BB6A"),
  frontend: folder(FolderCog, "#4FC3F7"),
  client: folder(FolderCog, "#4FC3F7"),
  mobile: folder(FolderCog, "#26A69A"),
  desktop: folder(FolderCog, "#7E57C2"),

  caches: folder(FolderArchive, "#90A4AE"),
  cache: folder(FolderArchive, "#90A4AE"),
  tmp: folder(FolderArchive, "#90A4AE"),
  temp: folder(FolderArchive, "#90A4AE"),

  logs: folder(FolderArchive, "#90A4AE"),
  log: folder(FolderArchive, "#90A4AE"),

  secrets: folder(FolderLock, "#E3B341"),
  private: folder(FolderLock, "#E3B341"),

  sync: folder(FolderSync, "#4DB6AC"),
  notifications: folder(FolderSync, "#4DB6AC"),

  search: folder(FolderSearch, "#4DB6AC"),
  auth: folder(FolderKey, "#E3B341"),
  user: folder(FolderKey, "#E3B341"),
  users: folder(FolderKey, "#E3B341")
};

const DEFAULT_FOLDER: FolderSpec = folder(Folder, "#8B96A8");

/* ------------------------------------------------------------------ */
/* Content badge                                                      */
/* The folder keeps its folder icon; this picks a small "main file"    */
/* icon to badge onto it based on what the folder mostly contains.    */
/* ------------------------------------------------------------------ */

const MEDIA_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif",
  "mp3", "wav", "flac", "ogg", "mp4", "mkv", "webm", "mov"
];

const EXT_RANK: Record<string, number> = {};
for (const ext of [
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "ipynb", "go", "rs", "java",
  "kt", "c", "h", "cpp", "cc", "cxx", "hpp", "hxx", "mq5", "mq4", "mqh",
  "cs", "rb", "php", "swift", "dart", "lua", "sh", "vue", "svelte", "astro",
  "scss", "less", "sql", "graphql", "gql"
]) EXT_RANK[ext] = 0;
for (const ext of MEDIA_EXTENSIONS) EXT_RANK[ext] = 1;
for (const ext of ["json", "jsonc", "lock", "toml", "yaml", "yml", "xml", "conf", "cfg", "ini", "props", "env"]) EXT_RANK[ext] = 2;
for (const ext of ["md", "markdown", "txt", "rst"]) EXT_RANK[ext] = 3;

/** Finds the most representative child file (its icon comes from file-icons),
 * preferring extension-based dominance, then category importance. */
function dominantFileSpec(names: string[]): IconSpec | null {
  const counts = new Map<string, { n: number; name: string }>();
  const order: string[] = [];

  for (const name of names) {
    const lower = name.toLowerCase();
    const fileSpec = fileIconFor(lower, "ignored");
    if (fileSpec === FILE_DEFAULT) continue;

    const dot = lower.lastIndexOf(".");
    const ext = dot > 0 && dot < lower.length - 1 ? lower.slice(dot + 1) : lower;
    const existing = counts.get(ext);
    if (existing) {
      existing.n += 1;
    } else {
      counts.set(ext, { n: 1, name: lower });
      order.push(ext);
    }
  }
  if (counts.size === 0) return null;

  let bestExt = order[0];
  let best = counts.get(bestExt)!;
  for (const ext of order) {
    const item = counts.get(ext)!;
    const better =
      item.n > best.n ||
      (item.n === best.n && (EXT_RANK[ext] ?? 99) < (EXT_RANK[bestExt] ?? 99));
    if (better) {
      bestExt = ext;
      best = item;
    }
  }
  return fileIconFor(best.name, "ignored");
}

/** Returns a small icon drinking the folder's dominant file, or null when
 * the folder name already explains itself (named folders) or nothing
 * recognizable lives inside. */
export function folderContentBadge(names: string[]): IconSpec | null {
  if (names.length === 0) return null;
  const lower = names.map((name) => name.toLowerCase());

  if (lower.some((name) => name === ".git" || name.startsWith(".git"))) {
    return fileIconFor(".gitignore", "ignored");
  }
  if (lower.some((name) => name.endsWith(".lock") || /^(package-lock|pnpm-lock|yarn|bun)\./.test(name))) {
    return fileIconFor("package-lock.json", "ignored");
  }
  return dominantFileSpec(lower);
}

export function folderIconFor(name: string, open: boolean): IconSpec {
  const lower = name.toLowerCase();
  const match = FOLDER_SPECS[lower];
  if (match) return open ? match.open : match.closed;
  return open ? DEFAULT_FOLDER.open : DEFAULT_FOLDER.closed;
}

/** Returns the color used for a folder's icon (and label) — known names get
 * their themed color, everything else uses the neutral fallback. */
export function folderColorFor(name: string): string {
  const lower = name.toLowerCase();
  const match = FOLDER_SPECS[lower];
  return match ? match.closed.color : DEFAULT_FOLDER.closed.color;
}
