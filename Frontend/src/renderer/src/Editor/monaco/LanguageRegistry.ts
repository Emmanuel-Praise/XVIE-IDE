import { getMonacoSync } from "./MonacoProvider";
import type { FileIdentity, LanguageDefinition } from "../language/types";

const PLAINTEXT: LanguageDefinition = {
  id: "plaintext",
  label: "Plain Text",
  loader: () => Promise.resolve()
};

function toDefinition(language: {
  id: string;
  aliases?: string[];
  extensions?: string[];
  filenames?: string[];
}): LanguageDefinition {
  return {
    id: language.id,
    label: language.aliases?.[0] ?? language.id,
    extensions: language.extensions?.map((extension) => extension.replace(/^\./, "")),
    filenames: language.filenames,
    loader: () => Promise.resolve()
  };
}

function languages(): LanguageDefinition[] {
  return getMonacoSync().languages.getLanguages().map(toDefinition);
}

export function languageLabel(id: string): string {
  return languages().find((language) => language.id === id)?.label ?? "Plain Text";
}

export function allLanguages(): LanguageDefinition[] {
  return languages();
}

/**
 * Explicit extension → Monaco language id map. Monaco bundles grammar support
 * for all of these, but basic languages usually do not register extension
 * metadata, so files would otherwise fall back to Plain Text. This curated map
 * bridges that gap and runs before Monaco's own metadata lookup.
 */
const EXTENSION_IDS: Record<string, string> = {
  // Scripting / JS ecosystem
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescript",

  // Trading / custom
  mq5: "mql5",
  mq4: "mql5",
  mqh: "mql5",
  pine: "pinescript",

  // Python
  py: "python",
  pyw: "python",
  pyi: "python",

  // Web
  html: "html",
  htm: "html",
  xhtml: "html",
  vue: "html",
  svelte: "html",
  astro: "html",
  css: "css",
  scss: "scss",
  sass: "scss",
  less: "less",
  svg: "xml",

  // Data / config
  json: "json",
  jsonc: "json",
  json5: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  cfg: "ini",
  conf: "ini",
  properties: "ini",
  env: "ini",
  xml: "xml",
  xsl: "xml",
  xsd: "xml",
  tsv: "plaintext",
  csv: "plaintext",

  // Markup / text
  md: "markdown",
  markdown: "markdown",
  mdown: "markdown",
  mdx: "mdx",
  rst: "restructuredtext",
  tex: "plaintext",
  txt: "plaintext",

  // Shells
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ksh: "shell",
  ps1: "powershell",
  psm1: "powershell",
  psd1: "powershell",
  bat: "bat",
  cmd: "bat",
  powershell: "powershell",

  // C-like family
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  m: "objective-c",
  mm: "objective-c",
  go: "go",
  rs: "rust",
  zig: "plaintext",
  wasm: "plaintext",
  d: "plaintext",

  // Functional
  hs: "plaintext",
  fs: "fsharp",
  fsi: "fsharp",
  fsx: "fsharp",
  clj: "clojure",
  cljs: "clojure",
  cljc: "clojure",
  elm: "plaintext",
  ex: "elixir",
  exs: "elixir",
  erl: "plaintext",
  hrl: "plaintext",
  lisp: "scheme",
  scm: "scheme",
  scala: "scala",
  sc: "scala",

  // Data langs
  sql: "sql",
  pgsql: "pgsql",
  mysql: "mysql",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",

  // Ops / infra
  dockerfile: "dockerfile",
  tf: "hcl",
  tfvars: "hcl",
  hcl: "hcl",
  nix: "plaintext",

  // Misc langs
  php: "php",
  rb: "ruby",
  rbi: "ruby",
  rake: "ruby",
  pl: "perl",
  pm: "perl",
  r: "r",
  lua: "lua",
  dart: "dart",
  sol: "solidity",
  pug: "pug",
  jade: "pug",
  handlebars: "handlebars",
  hbs: "handlebars",
  twig: "twig",
  razor: "razor",
  cshtml: "razor",
  jl: "julia",

  // Template / misc text
  ejs: "javascript",
  hjson: "json",
  webmanifest: "json",
  map: "json",
  ipynb: "json"
};

/** Explicit exact-filename (lowercase) → Monaco language id map. */
const FILENAME_IDS: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "plaintext",
  gemfile: "ruby",
  guardfile: "ruby",
  rakefile: "ruby",
  vagrantfile: "ruby",
  podfile: "ruby",
  cmakelists: "plaintext",

  ".env": "ini",
  ".env.example": "ini",
  ".env.local": "ini",
  ".env.production": "ini",
  ".env.development": "ini",
  ".env.test": "ini",
  ".gitignore": "plaintext",
  ".gitattributes": "plaintext",
  ".gitmodules": "plaintext",
  ".gitconfig": "ini",
  ".npmrc": "ini",
  ".editorconfig": "ini",
  ".prettierrc": "json",
  ".babelrc": "json",
  ".eslintrc": "json",
  ".clang-format": "plaintext",
  ".clang-tidy": "plaintext",
  ".terraformrc": "hcl",

  "package-lock": "json",
  "composer.json": "json",
  "tsconfig": "json",
  "jsconfig": "json",
  "deno.json": "json",
  "deno.jsonc": "jsonc",
  ".jshintrc": "json",
  ".stylelintrc": "json",

  "vimrc": "plaintext",
  "bashrc": "shell",
  "bash_profile": "shell",
  "zshrc": "shell",
  "profile": "shell"
};

/**
 * Resolve a file's language. Priority order:
 * curated filename map → curated extension map → Monaco's own registered
 * filename/extension metadata → plain text.
 */
export function resolveLanguage(identity: FileIdentity, _content?: string): LanguageDefinition {
  const name = identity.name.toLowerCase();

  const byFilename = FILENAME_IDS[name];
  if (byFilename) return toDefinition({ id: byFilename });

  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    const ext = name.slice(dot + 1);
    const byExt = EXTENSION_IDS[ext];
    if (byExt) return toDefinition({ id: byExt });

    const registeredLanguages = languages();
    const match = registeredLanguages.find((language) =>
      language.extensions?.includes(ext)
    );
    if (match) return match;
  }

  const registeredLanguages = languages();
  const filenameMatch = registeredLanguages.find((language) =>
    language.filenames?.some((filename) => filename.toLowerCase() === name)
  );
  if (filenameMatch) return filenameMatch;

  return PLAINTEXT;
}