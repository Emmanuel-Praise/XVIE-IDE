import { describe, expect, it } from "vitest";
import { visibleAgentDraft } from "../src/Agent/agentDraft";

describe("XVIE Agent streamed draft filtering", () => {
  it("shows streamed user-facing prose", () => {
    expect(visibleAgentDraft("I found the cause and am checking it now.")).toContain("I found the cause");
  });

  it("hides incomplete JSON and native tool protocol payloads", () => {
    expect(visibleAgentDraft('{"actions":[{"tool":"write_file"}')).toBe("");
    expect(visibleAgentDraft("```json\n{\"actions\":[]}")).toBe("");
    expect(visibleAgentDraft("<|tool_calls_section_begin|>")).toBe("");
  });

  it("keeps non-JSON code examples visible", () => {
    expect(visibleAgentDraft("```html\n<section>Hello</section>")).toContain("<section>");
  });
});
