import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { collectBareToolActions, isPlaceholderAgentPath, isStructuredAgentReply, normalizeAgentReply, normalizeBrowserToolAction, parseAgentJson, parseAgentJsonCandidates, parseAgentJsonShaped, parseAgentJsonWithRetry, previewBrowserAgentStream, projectFilePriority, repairModelJson, requestedFileMustBePreserved, requestedProjectFileNames, salvageBacktrackJson } from "../src/Browser/browserAgentProtocol";
import MessageMarkdown from "../src/Agent/components/conversation/message-markdown";

describe("Browser Agent model response parsing", () => {
  it("shows streamed summary text before the tool JSON is complete without exposing the protocol", () => {
    expect(previewBrowserAgentStream('{"summary":"I am checking the page')).toContain("I am checking the page");
    expect(previewBrowserAgentStream('{"actions":[{"tool":"write_file","args":{"content":"secret"}}]}')).toBeNull();
    expect(previewBrowserAgentStream('{"summary":"Escaped quote: \\" still streaming')).toContain('Escaped quote: "');
  });

  it("normalizes the name/arguments tool calls returned by browser models", () => {
    // search_text is canonicalized to xvie grep_search (same as backend _TOOL_ALIASES).
    expect(normalizeBrowserToolAction({ name: "search_text", arguments: { query: "veyra", case_sensitive: false } }))
      .toEqual({ tool: "grep_search", args: { query: "veyra", case_sensitive: false, pattern: "veyra" } });
  });

  it("normalizes DeepSeek's type plus flat-arguments tool calls", () => {
    // type discriminator is stripped from args; list_files -> list_dir.
    expect(normalizeBrowserToolAction({ type: "list_files", path: "." }))
      .toEqual({ tool: "list_dir", args: { path: "." } });
    expect(normalizeBrowserToolAction({ type: "read_file", path: "index.html" }))
      .toEqual({ tool: "read_file", args: { path: "index.html" } });
    expect(normalizeBrowserToolAction({ type: "think", summary: "Inspecting the project." }))
      .toEqual({ tool: "think", args: { summary: "Inspecting the project.", thought: "Inspecting the project." } });
    expect(normalizeBrowserToolAction({ type: "write_plan", title: "Plan", steps: [] }))
      .toEqual({ tool: "write_plan", args: { title: "Plan", steps: [] } });
  });

  it("accepts action/functionName aliases so DeepSeek never hits unnamed-action", () => {
    expect(normalizeBrowserToolAction({ action: "read_file", arguments: { path: "index.html" } }))
      .toEqual({ tool: "read_file", args: { path: "index.html" } });
    expect(normalizeBrowserToolAction({ functionName: "list_files", args: { path: "." } }).tool).toBe("list_dir");
    expect(normalizeBrowserToolAction({ tool: "READ_FILE", args: { path: "index.html" } }).tool).toBe("read_file");
  });

  it("keeps canonical and nested function tool calls compatible", () => {
    expect(normalizeBrowserToolAction({ tool: "read_file", args: { path: "index.html" } }))
      .toEqual({ tool: "read_file", args: { path: "index.html" } });
    expect(normalizeBrowserToolAction({ function: { name: "search_text", arguments: "{\"query\":\"veyra\"}" } }))
      .toEqual({ tool: "grep_search", args: { query: "veyra", pattern: "veyra" } });
  });

  it("returns a useful error for malformed tool actions", () => {
    expect(normalizeBrowserToolAction({ name: "search_text", arguments: "not-json" }))
      .toEqual({ tool: "grep_search", args: {}, error: "Tool arguments were not valid JSON." });
    expect(normalizeBrowserToolAction({ arguments: {} }).error).toBe("Tool action is missing its name.");
  });

  it("extracts JSON surrounded by prose", () => {
    expect(parseAgentJson<{ actions: unknown[] }>("Here is my response:\n{\"actions\":[]}\nDone.")).toEqual({ actions: [] });
  });

  it("prefers the tool envelope over inner fragments from DSML markup", () => {
    const mixed = "Prose <invoke name=\"list_dir\"><parameter name=\"args\">{\"path\": \".\"}</parameter></invoke> tail\n{\"actions\":[{\"tool\":\"list_dir\",\"args\":{\"path\":\".\"}}]}";
    const shaped = parseAgentJsonShaped(mixed, (v): v is { actions: unknown[] } =>
      !!v && typeof v === "object" && Array.isArray((v as { actions?: unknown }).actions));
    expect(shaped.actions).toHaveLength(1);
    expect(parseAgentJsonCandidates(mixed).length).toBeGreaterThan(1);
  });

  it("ignores a truncated trailing envelope when a complete one exists", () => {
    const complete = "{\"actions\":[{\"tool\":\"finish\"}]}";
    const text = `${complete} trailing prose {"actions":[{"tool":"write_plan","args":{"title":"T","steps":[{"title":"S1"}... cut off`;
    const shaped = parseAgentJsonShaped(text, (v): v is { actions: unknown[] } =>
      !!v && typeof v === "object" && Array.isArray((v as { actions?: unknown }).actions));
    expect(shaped).toEqual({ actions: [{ tool: "finish" }] });
  });

  it("respects braces and escaped quotes inside generated file content", () => {
    const value = parseAgentJson<{ files: Array<{ content: string }> }>(
      "```json\n{\"files\":[{\"content\":\"const x = '{\\\"ok\\\": true}';\"}]}\n```"
    );
    expect(value.files[0].content).toContain("ok");
  });

  it("does not join a JSON response to trailing JSON or prose", () => {
    expect(parseAgentJson<{ subtasks: string[] }>("{\"subtasks\":[\"one\"]}{broken trailing text")).toEqual({ subtasks: ["one"] });
  });

  it("does not make another model call when the first response is valid", async () => {
    const ask = vi.fn(async () => "unused");
    const result = await parseAgentJsonWithRetry({
      response: "{\"actions\":[{\"tool\":\"finish\"}]}",
      ask,
      isValid: (value): value is { actions: unknown[] } =>
        !!value && typeof value === "object" && Array.isArray((value as { actions?: unknown }).actions),
      retryPrompt: () => "repair"
    });
    expect(result.actions).toHaveLength(1);
    expect(ask).not.toHaveBeenCalled();
  });

  it("repairs a malformed first response once", async () => {
    const ask = vi.fn(async () => "{\"actions\":[{\"tool\":\"finish\"}]}");
    const onRetry = vi.fn();
    const result = await parseAgentJsonWithRetry({
      response: "I will inspect the files first.",
      ask,
      isValid: (value): value is { actions: unknown[] } =>
        !!value && typeof value === "object" && Array.isArray((value as { actions?: unknown }).actions),
      retryPrompt: (previous) => `Return tool JSON. Previous response: ${previous}`,
      onRetry,
    });
    expect(result.actions).toHaveLength(1);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask.mock.calls[0][0]).toContain("I will inspect the files first.");
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Number), true);
  });

  it("reports the later malformed turn and keeps it out of staged edits", async () => {
    const ask = vi.fn(async () => "Still not JSON; I cannot continue.");
    await expect(parseAgentJsonWithRetry({
      response: "Here is an invalid follow-up response.",
      ask,
      isValid: (value): value is { actions: unknown[] } =>
        !!value && typeof value === "object" && Array.isArray((value as { actions?: unknown }).actions),
      retryPrompt: () => "Return only valid tool JSON."
    })).rejects.toThrow(/No workspace edits were staged.*Still not JSON/);
    // Keeps retrying through malformed turns (up to 3 repair rounds) before giving up.
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("salvages unescaped HTML quotes in file content without a repair round-trip", async () => {
    const ask = vi.fn(async () => "unused");
    const raw = '{"actions":[{"tool":"write_file","args":{"path":"a.html","content":"<html lang="en"><p>Hi</p>"}}]}';
    const result = await parseAgentJsonWithRetry({
      response: raw,
      ask,
      isValid: (value): value is { actions: Array<{ tool: string }> } =>
        !!value && typeof value === "object" && Array.isArray((value as { actions?: unknown }).actions),
      retryPrompt: () => "repair"
    });
    expect(result.actions).toHaveLength(1);
    expect(ask).not.toHaveBeenCalled();
  });

  it("salvages quoted CSS values followed by commas via backtracking", () => {
    // Exact failure shape from a live DeepSeek run: "Segoe UI", inside content.
    const raw = '{"tools":[{"tool":"write_file","args":{"path":"demo/hello.html","content":"<html lang="en"><style>body{font-family:system-ui, "Segoe UI", sans-serif;}</style>"}}]}';
    const shaped = parseAgentJsonShaped(raw, (v): v is { tools: Array<{ tool: string; args: { content: string } }> } =>
      !!v && typeof v === "object" && Array.isArray((v as { tools?: unknown }).tools));
    expect(shaped.tools).toHaveLength(1);
    expect(shaped.tools[0].args.content).toContain('"Segoe UI", sans-serif');
    expect(salvageBacktrackJson('{"tools":[]}')).toEqual({ tools: [] });
  });

  it("collects bare single-action objects and dedupes repeats", () => {
    const raw = '{"tool":"list_dir","args":{"path":"."}}\n{"tool":"list_dir","args":{"path":"."}}';
    const collected = collectBareToolActions(raw);
    expect(collected).toEqual([{ tool: "list_dir", args: { path: "." } }]);
  });

  it("prefers the envelope when bare actions and envelope coexist", () => {
    const raw = '{"tool":"think","args":{"thought":"hi"}}\n{"actions":[{"tool":"finish"}]}';
    const shaped = parseAgentJsonShaped(raw, (v): v is { actions: unknown[] } =>
      !!v && typeof v === "object" && Array.isArray((v as { actions?: unknown }).actions));
    expect(shaped).toEqual({ actions: [{ tool: "finish" }] });
  });

  it("accepts every unified reply shape (tool, direct, files, done)", () => {
    // Greeting / tool-free answer: model decides, no prose outside JSON.
    expect(isStructuredAgentReply({ actions: [], message: "Hi! How can I help?" })).toBe(true);
    expect(normalizeAgentReply({ actions: [], message: "Hi!" })).toEqual({ actions: [], summary: "Hi!" });
    expect(normalizeAgentReply({ answer: "The button is blue." })).toEqual({ actions: [], summary: "The button is blue." });
    // Tool turn and explicit finish keep working.
    expect(normalizeAgentReply({ actions: [{ tool: "think" }], summary: "s" })?.actions).toHaveLength(1);
    expect(normalizeAgentReply({ done: true, answer: "All done." })).toEqual({ actions: [], summary: "All done.", done: true });
    // Prose and empty objects are rejected (never pasted into chat).
    expect(isStructuredAgentReply("just prose")).toBe(false);
    expect(isStructuredAgentReply({})).toBe(false);
    expect(normalizeAgentReply({ actions: [], summary: "" })).toEqual({ actions: [], summary: "" });
  });

  it("leaves already-valid JSON byte-identical (salvage never corrupts)", () => {
    const raw = '{"actions":[{"tool":"read_file","args":{"path":"index.html"}}]}';
    expect(parseAgentJsonShaped(raw, (v): v is { actions: unknown[] } =>
      !!v && typeof v === "object" && Array.isArray((v as { actions?: unknown }).actions)
    )).toEqual({ actions: [{ tool: "read_file", args: { path: "index.html" } }] });
    expect(repairModelJson(raw)).toBeNull();
  });

  it("retries JSON that has the wrong response shape", async () => {
    const ask = vi.fn(async () => "{\"actions\":[{\"tool\":\"finish\"}]}");
    const result = await parseAgentJsonWithRetry({
      response: "{\"summary\":\"Done\"}",
      ask,
      isValid: (value): value is { actions: unknown[] } =>
        !!value && typeof value === "object" && Array.isArray((value as { actions?: unknown }).actions),
      retryPrompt: (_previous, reason) => reason
    });
    expect(result.actions).toHaveLength(1);
    expect(ask.mock.calls[0][0]).toContain("required Browser Agent response shape");
  });

  it("renders assistant replies as Markdown", () => {
    const html = renderToStaticMarkup(createElement(MessageMarkdown, {
      content: "A **clear** reply\n\n- First item\n- Second item"
    }));
    expect(html).toContain("<strong>clear</strong>");
    expect(html).toContain("<ul>");
  });

  it("identifies schema example paths so they cannot become workspace edits", () => {
    expect(isPlaceholderAgentPath("relative/file")).toBe(true);
    expect(isPlaceholderAgentPath("optional/prefix")).toBe(true);
    expect(isPlaceholderAgentPath("src/index.html")).toBe(false);
  });

  it("prioritizes an explicitly named file in the bounded workspace snapshot", () => {
    const requested = requestedProjectFileNames("Please restyle the INDEX.HTML code");
    expect(requested.has("index.html")).toBe(true);
    expect(projectFilePriority("public/index.html", "Please restyle the INDEX.HTML code", requested))
      .toBeGreaterThan(projectFilePriority("src/agent.ts", "Please restyle the INDEX.HTML code", requested));
  });

  it("protects a named original when the user asks for another version", () => {
    const task = "Create another version of INDEX.HTML without destroying this one";
    expect(requestedFileMustBePreserved(task, "public/index.html")).toBe(true);
    expect(requestedFileMustBePreserved(task, "public/index-redesign.html")).toBe(false);
    expect(requestedFileMustBePreserved("Update INDEX.HTML styles", "index.html")).toBe(false);
  });
});
