import { describe, expect, it } from "vitest";
import { conversationKey, isImplementSavedPlanRequest, normalizeTaskSpelling, toolsForBrowserXvieMode } from "../src/Browser/browserXvieModes";

describe("Browser plan routing (implement-the-plan flow)", () => {
  it("tolerates the impliment misspelling", () => {
    expect(normalizeTaskSpelling("impliment the plan")).toBe("implement the plan");
    expect(isImplementSavedPlanRequest("impliment the plan")).toBe(true);
  });

  it("routes implement-the-plan phrasings to the build flow", () => {
    expect(isImplementSavedPlanRequest("implement the plan")).toBe(true);
    expect(isImplementSavedPlanRequest("please proceed and implement the plan please")).toBe(true);
    expect(isImplementSavedPlanRequest("go")).toBe(false);
    expect(isImplementSavedPlanRequest("continue it")).toBe(false);
    expect(isImplementSavedPlanRequest("continue with the saved plan")).toBe(true);
    expect(isImplementSavedPlanRequest("Build a landing page for Veyra X1")).toBe(false);
  });

  it("keys provider threads by site and mode", () => {
    expect(conversationKey("deepseek", "plan")).toBe("deepseek:plan");
    expect(conversationKey("deepseek", "plan")).not.toBe(conversationKey("deepseek", "code"));
  });

  it("advertises xvie-canonical tool names per mode", () => {
    expect(toolsForBrowserXvieMode("plan")).toContain("write_plan");
    expect(toolsForBrowserXvieMode("plan")).not.toContain("write_file");
    expect(toolsForBrowserXvieMode("code")).toContain("write_file");
    expect(toolsForBrowserXvieMode("ask")).not.toContain("write_plan");
    expect(toolsForBrowserXvieMode("code")).toContain("list_dir");
    expect(toolsForBrowserXvieMode("code")).not.toContain("list_files");
  });
});
