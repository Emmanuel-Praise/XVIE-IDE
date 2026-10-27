import type { MonacoApi } from "./MonacoProvider";

/**
 * Registers Xvie's custom Monaco languages that aren't bundled with Monaco:
 * MQL5 / MQL4 (MetaTrader) and PineScript (TradingView).
 * Idempotent — safe to call multiple times.
 */
export function registerCustomLanguages(monaco: MonacoApi): void {
  registerMql(monaco);
  registerPineScript(monaco);
}

const MQL_KEYWORDS = [
  "int", "long", "short", "char", "uchar", "float", "double", "bool", "string",
  "datetime", "color", "void", "struct", "class", "enum", "union", "typedef",
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "new", "delete", "this", "true", "false", "input",
  "extern", "static", "const", "virtual", "override", "final", "public",
  "private", "protected", "template", "typename", "using", "namespace",
  "sizeof", "gcc", "defined"
];

const MQL_PREPROCESSOR = [
  "#property", "#include", "#define", "#undef", "#import", "#export",
  "#ifdef", "#ifndef", "#else", "#endif", "#pragma", "#error", "#warning",
  "#resource"
];

const PINE_KEYWORDS = [
  "indicator", "strategy", "library", "study", "plot", "plotshape", "plotchar",
  "plotbar", "plotcandle", "plotarrow", "alertcondition", "input", "int",
  "float", "bool", "string", "color", "true", "false", "na", "and", "or",
  "not", "in", "if", "else", "for", "while", "var", "varip", "switch",
  "series", "simple", "const", "type", "method", "import", "export", "void"
];

const PINE_TYPES = [
  "line", "label", "box", "table", "array", "matrix", "map", "polyline",
  "linefill", "hline", "vline", "shape", "pie", "chart", "timeframe",
  "syminfo", "barstate", "session", "time", "range", "source", "bool"
];

function registerMql(monaco: MonacoApi): void {
  const id = "mql5";
  if (monaco.languages.getLanguages().some((language) => language.id === id)) return;

  monaco.languages.register({
    id,
    extensions: [".mq5", ".mq4", ".mqh"],
    aliases: ["MQL5", "MQL4", "MetaQuotes Language"]
  });

  monaco.languages.setMonarchTokensProvider(id, {
    defaultToken: "",
    tokenPostfix: ".mql",

    keywords: MQL_KEYWORDS,
    typeKeywords: [
      "int", "long", "short", "char", "uchar", "float", "double", "bool", "string",
      "datetime", "color"
    ],
    preprocessor: MQL_PREPROCESSOR,

    brackets: [
      { open: "{", close: "}", token: "delimiter.curly" },
      { open: "[", close: "]", token: "delimiter.bracket" },
      { open: "(", close: ")", token: "delimiter.parenthesis" },
      { open: "<", close: ">", token: "delimiter.angle" }
    ],

    operators: [
      "=", ">", "<", "!", "~", "?", ":", "==", "<=", ">=", "!=", "&&", "||",
      "++", "--", "+", "-", "*", "/", "&", "|", "^", "%", "<<", ">>", "+=",
      "-=", "*=", "/=", "&=", "|=", "^=", "%=", "<<=", ">>="
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    tokenizer: {
      root: [
        [/[{}()[\]<>]/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],

        [/#\s*[a-zA-Z_][\w$]*/, { cases: { "@preprocessor": "keyword.preprocessor", "@default": "keyword.preprocessor" } }],

        [/@\s*[a-zA-Z_$][\w$]*/, "annotation"],

        [/\d+\.\d*(e[-+]?\d+)?/, "number.float"],
        [/\d+(e[-+]?\d+)?/, "number"],
        [/0[xX][0-9a-fA-F]+/, "number.hex"],
        [/0[bB][01]+/, "number.binary"],

        [/[a-zA-Z_$][\w$]*/, {
          cases: {
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@default": "identifier"
          }
        }],

        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
        [/\/\*/, "comment", "@blockComment"],
        [/\/\/.*$/, "comment"]
      ],

      blockComment: [
        [/[^*/]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[*/]/, "comment"]
      ],

      string: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }]
      ]
    }
  });
}

function registerPineScript(monaco: MonacoApi): void {
  const id = "pinescript";
  if (monaco.languages.getLanguages().some((language) => language.id === id)) return;

  monaco.languages.register({
    id,
    extensions: [".pine"],
    aliases: ["PineScript", "Pine Script"]
  });

  monaco.languages.setMonarchTokensProvider(id, {
    defaultToken: "",
    tokenPostfix: ".pine",

    keywords: PINE_KEYWORDS,
    typeKeywords: PINE_TYPES,

    brackets: [
      { open: "{", close: "}", token: "delimiter.curly" },
      { open: "[", close: "]", token: "delimiter.bracket" },
      { open: "(", close: ")", token: "delimiter.parenthesis" }
    ],

    operators: [
      "=", ">", "<", "!", "?", ":", "==", "<=", ">=", "!=", "&&", "||", "+",
      "-", "*", "/", "%", "&", "|", "^", "+=", "-=", "*=", "/=", "=>"
    ],
    symbols: /[=><!~?:&|+\-*/^%]+/,
    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4})/,

    tokenizer: {
      root: [
        [/[{}()[\]]/, "@brackets"],
        [/@symbols/, { cases: { "@operators": "operator", "@default": "" } }],

        [/\/\/@@version\s*[0-9]+/, "keyword.directive"],
        [/@\s*[a-zA-Z_$][\w$]*/, "annotation"],

        [/\d+\.\d*(e[-+]?\d+)?/, "number.float"],
        [/\d+(e[-+]?\d+)?/, "number"],
        [/0[xX][0-9a-fA-F]+/, "number.hex"],

        [/[a-zA-Z_$][\w$]*\s*(?=\()/, {
          cases: {
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@default": "function"
          }
        }],
        [/[a-zA-Z_$][\w$]*/, {
          cases: {
            "@keywords": "keyword",
            "@typeKeywords": "type",
            "@default": "identifier"
          }
        }],

        [/"([^"\\]|\\.)*$/, "string.invalid"],
        [/"/, { token: "string.quote", bracket: "@open", next: "@string" }],
        [/\/\*/, "comment", "@blockComment"],
        [/\/\/.*$/, "comment"]
      ],

      blockComment: [
        [/[^*/]+/, "comment"],
        [/\*\//, "comment", "@pop"],
        [/[*/]/, "comment"]
      ],

      string: [
        [/[^\\"]+/, "string"],
        [/@escapes/, "string.escape"],
        [/\\./, "string.escape.invalid"],
        [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }]
      ]
    }
  });
}