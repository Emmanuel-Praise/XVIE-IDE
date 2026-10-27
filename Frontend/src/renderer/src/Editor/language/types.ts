export interface LanguageDefinition {
  /** Monaco language id (e.g. "typescript", "jsx", "plaintext"). */
  id: string;
  /** Human-readable label shown in the status bar (e.g. "TypeScript (React)"). */
  label: string;
  /** File extensions without leading dot, lowercase (e.g. "ts", "tsx"). */
  extensions?: string[];
  /** Exact filenames, case-insensitive (e.g. "Dockerfile", "package.json"). */
  filenames?: string[];
  /** Substrings matched against the first line after "#!" (e.g. "python3"). */
  shebangs?: string[];
  /**
   * Loads and registers the Monaco grammar for this language.
   * May be lazy; called once per language and cached.
   */
  loader: () => Promise<void>;
}

export interface FileIdentity {
  name: string;
  path: string;
}
