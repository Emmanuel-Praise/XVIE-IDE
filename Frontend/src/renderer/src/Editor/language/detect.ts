import type { FileIdentity, LanguageDefinition } from "./types";

interface Lookup {
  byFilename: (name: string) => LanguageDefinition | undefined;
  byExtension: (ext: string) => LanguageDefinition | undefined;
  byShebang: (line: string) => LanguageDefinition | undefined;
  byId: (id: string) => LanguageDefinition | undefined;
}

const PLAINTEXT: LanguageDefinition = {
  id: "plaintext",
  label: "Plain Text",
  loader: () => Promise.resolve()
};

const JSON_SNIFF_LIMIT = 64 * 1024;

function sniffContent(content: string): string | undefined {
  const firstNonSpace = content.search(/\S/);
  const head = content.slice(firstNonSpace, firstNonSpace + 64).toLowerCase();

  if (head.startsWith("<?xml")) return "xml";
  if (head.startsWith("<!doctype") || head.startsWith("<html")) return "html";

  const firstChar = content[firstNonSpace];
  if (firstChar === "{" || firstChar === "[") {
    if (content.length <= JSON_SNIFF_LIMIT) {
      try {
        JSON.parse(content);
        return "json";
      } catch {
        return undefined;
      }
    }
    const tail = content.trimEnd();
    const lastChar = tail[tail.length - 1];
    if ((firstChar === "{" && lastChar === "}") || (firstChar === "[" && lastChar === "]")) {
      return "json";
    }
  }
  return undefined;
}

/**
 * Detects a file's language. Priority order:
 * exact filename → extension → content (shebang, XML/HTML/JSON heuristics) → plain text.
 */
export function detectLanguage(
  identity: FileIdentity,
  content: string | undefined,
  lookup: Lookup
): LanguageDefinition {
  const name = identity.name.toLowerCase();

  const byName = lookup.byFilename(name);
  if (byName) return byName;

  const dot = name.lastIndexOf(".");
  if (dot > 0 && dot < name.length - 1) {
    const byExt = lookup.byExtension(name.slice(dot + 1));
    if (byExt) return byExt;
  }

  if (content) {
    const newline = content.indexOf("\n");
    const firstLine = newline === -1 ? content : content.slice(0, newline);
    if (firstLine.startsWith("#!")) {
      const byShebang = lookup.byShebang(firstLine);
      if (byShebang) return byShebang;
    }
    const sniffed = sniffContent(content);
    if (sniffed) {
      const def = lookup.byId(sniffed);
      if (def) return def;
    }
  }

  return PLAINTEXT;
}
