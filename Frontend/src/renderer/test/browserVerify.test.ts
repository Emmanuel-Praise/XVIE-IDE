import { describe, expect, it } from "vitest";
import {
  contrastRatio,
  findMissingCssClasses,
  formatContrastReport,
  matchPlanStepTitle,
  verifyCssContent,
  verifyFileContent,
  verifyHtmlContent,
  verifyJsContent,
} from "../src/Browser/browserVerify";

const STEPS = [
  { title: "Scaffold veyra-x1 folder and core files" },
  { title: "Define design tokens in veyra-x1/styles.css" },
  { title: "Build cinematic hero section" },
];

describe("mark_task_done title matching", () => {
  it("matches exact titles case-insensitively", () => {
    expect(matchPlanStepTitle(STEPS, "Build cinematic hero section")).toEqual({ index: 2 });
    expect(matchPlanStepTitle(STEPS, "build CINEMATIC hero SECTION")).toEqual({ index: 2 });
  });

  it("matches normalized and unique partial titles", () => {
    expect(matchPlanStepTitle(STEPS, "Build cinematic hero section!")).toEqual({ index: 2 });
    expect(matchPlanStepTitle(STEPS, "hero section")).toEqual({ index: 2 });
    expect(matchPlanStepTitle(STEPS, "scaffold")).toEqual({ index: 0 });
  });

  it("lists open titles when nothing matches", () => {
    const result = matchPlanStepTitle(STEPS, "deploy to production");
    expect("error" in result && result.error).toContain("Build cinematic hero section");
  });

  it("lists open titles even for an empty title", () => {
    const result = matchPlanStepTitle(STEPS, "   ");
    expect("error" in result && result.error).toContain("Scaffold veyra-x1 folder and core files");
  });

  it("rejects ambiguous partials with the options", () => {
    const result = matchPlanStepTitle(STEPS, "veyra-x1");
    expect("error" in result && result.error).toContain("Multiple");
  });
});

describe("HTML verification", () => {
  const GOOD = '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8"><title>T</title></head><body><main><h1>Hi</h1></main></body></html>';
  it("passes a complete page", () => {
    expect(verifyHtmlContent(GOOD)).toEqual([]);
  });

  it("flags missing doctype and skeleton", () => {
    const problems = verifyHtmlContent("<div><p>hi</p></div>");
    expect(problems.join("\n")).toContain("<!DOCTYPE html>");
  });

  it("flags truncated chunks (mismatched/unclosed tags)", () => {
    const problems = verifyHtmlContent(`${GOOD.slice(0, GOOD.indexOf("</main>"))}`);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe("CSS verification", () => {
  it("passes balanced CSS", () => {
    expect(verifyCssContent(":root{--x:1;}\n.card{color:red;}")).toEqual([]);
  });

  it("flags unbalanced braces from truncation", () => {
    expect(verifyCssContent(".card{color:red;\n.foo{margin:0;}")).toHaveLength(1);
  });

  it("flags empty files", () => {
    expect(verifyCssContent("  ")).toHaveLength(1);
  });

  it("flags an unclosed block comment that would hide the remaining stylesheet", () => {
    expect(verifyCssContent(".card { color: red; }\n/* unfinished\n.hidden { display: none; }"))
      .toContain("Unclosed CSS block comment (missing */); the rest of the stylesheet would be ignored.");
  });

  it("accepts a closed multiline comment with decorative line-leading stars", () => {
    expect(verifyCssContent("/* heading\n * explanation\n */\n.card { color: red; }")).toEqual([]);
  });

  it("passes a line-leading universal selector and detects CSS rules swallowed by a closed comment", () => {
    expect(verifyCssContent("* { box-sizing: border-box; }\n.card { color: red; }")).toEqual([]);
    const swallowed = "/* Header /\n.site-header { position: sticky; }\n.brand { display: flex; color: red; }\n/ Hero /\n.hero { padding: 2rem; }\n/ Layout */";
    expect(verifyCssContent(swallowed).join("\n")).toContain("CSS rule blocks appear inside a comment");
  });

  it("does not treat comment markers inside quoted CSS strings as comments", () => {
    expect(verifyCssContent('.card::after { content: "/* not a comment */"; }')).toEqual([]);
  });
});

describe("JS verification", () => {
  it("passes a valid IIFE", () => {
    expect(verifyJsContent("(function(){var x=1;console.log(x);})();")).toEqual([]);
  });

  it("flags syntax errors", () => {
    const problems = verifyJsContent("function broken( {");
    expect(problems.length).toBeGreaterThanOrEqual(1);
    expect(problems.join("\n")).toContain("syntax error");
  });

  it("catches missing template-literal delimiters in generated HTML strings", () => {
    const broken = `function createDishCard(dish) {
      const card = document.createElement('article');
      card.innerHTML =
        <div class="dish-media"><img src="${"${dish.image}"}" /></div>;
      return card;
    }`;
    expect(verifyJsContent(broken).join("\n")).toContain("syntax error");
  });

  it("does not strip comment-like text inside JavaScript strings", () => {
    expect(verifyJsContent(`const url = "https://example.test/path/*literal*/"; // real comment\nconsole.log(url);`)).toEqual([]);
  });

  it("rejects an unclosed block comment", () => {
    expect(verifyJsContent("const value = 1;\n/* comment without its closing star").join("\n"))
      .toContain("Unclosed JavaScript block comment (missing */)");
  });

  it("tolerates import/export lines in plain-script check", () => {
    expect(verifyJsContent("import x from 'y';\nconst a = 1;\nexport default a;")).toEqual([]);
  });
});

describe("verifyFileContent dispatch", () => {
  it("routes by extension", () => {
    expect(verifyFileContent("a.html", "<p>x</p>")).toContain("Missing <!DOCTYPE html>.");
    expect(verifyFileContent("a.css", "")).toHaveLength(1);
    expect(verifyFileContent("a.txt", "anything")).toEqual([]);
  });
});

describe("CSS class coverage", () => {
  it("reports classes without rules", () => {
    const missing = findMissingCssClasses(
      ['<div class="hero ghost">x</div>'],
      [".hero{color:red;}"]
    );
    expect(missing).toEqual(["ghost"]);
  });
});

describe("contrast", () => {
  it("computes known ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 3);
    expect(contrastRatio("nope", "#ffffff")).toBeNull();
  });

  it("formats a WCAG report", () => {
    const report = formatContrastReport("#1a1a1a", "#ffffff");
    expect(report).toContain("PASS");
    expect(formatContrastReport("zzz", "#fff")).toContain("Invalid");
  });
});
