import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentStore } from "../src/Agent/agentStore";
import { useRightPanelStore } from "../src/RightPanel/rightPanelStore";
import { useFileSystemStore } from "../src/Editor/fs/fileSystemStore";

const result = (output: string, stop_reason = "completed") => ({
  session_id: "session-1", final_output: output, stop_reason, turns: 1, tool_calls: [],
  usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 },
  confirmation_required: stop_reason === "awaiting_approval"
});

describe("live Agent state", () => {
  const api = {
    providers: vi.fn().mockResolvedValue([{ name: "Local", baseUrl: "https://api.example", model: "model", configured: true }]),
    saveProvider: vi.fn().mockResolvedValue({ success: true }),
    run: vi.fn().mockResolvedValue({ session_id: "session-1" }),
    events: vi.fn(), approve: vi.fn().mockResolvedValue({ success: true }),
    reject: vi.fn().mockResolvedValue({ success: true }), stop: vi.fn().mockResolvedValue({ success: true }),
    sessions: vi.fn().mockResolvedValue([]), session: vi.fn()
  };

  beforeEach(() => {
    vi.stubGlobal("window", { api: { agent: api, workspace: {} }, setTimeout });
    vi.clearAllMocks();
    api.providers.mockResolvedValue([{ name: "Local", baseUrl: "https://api.example", model: "model", configured: true }]);
    api.saveProvider.mockResolvedValue({ success: true });
    api.run.mockResolvedValue({ session_id: "session-1" });
    api.approve.mockResolvedValue({ success: true });
    api.reject.mockResolvedValue({ success: true });
    api.stop.mockResolvedValue({ success: true });
    api.sessions.mockResolvedValue([]);
    useFileSystemStore.setState({ workspace: { path: "C:/work/project", name: "project" } });
    useAgentStore.setState({ sessions: [], activeSessionId: null, notifications: [], history: [], providers: [], selectedProvider: "", mode: "code", draft: "", open: false, sidebarOpen: true });
    useRightPanelStore.setState({ open: false, view: "agent" });
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("shows one final reply instead of interim model narration", async () => {
    api.events.mockResolvedValueOnce({ running: false, events: [
      { id: 1, type: "activity", event: { kind: "model_text", message: "Working", data: { delta: "Working" } } },
      { id: 2, type: "activity", event: { kind: "tool_started", message: "Reading files", data: { tool: "read_file", path: "src/app.ts" } } },
      { id: 3, type: "completed", result: result("Done") }
    ] });
    useAgentStore.getState().sendMessage("Inspect the project", "code");
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.status).toBe("completed"));
    const session = useAgentStore.getState().activeSession()!;
    expect(session.messages.map((message) => message.content)).toContain("Done");
    expect(session.messages.map((message) => message.content)).not.toContain("Working");
    expect(session.activity[0]?.status).toBe("running");
    expect(session.usage?.totalTokens).toBe(16);
  });

  it("keeps streamed prose live, clears it before tool work, and commits the final answer once", async () => {
    api.events
      .mockResolvedValueOnce({ running: true, events: [
        { id: 1, type: "activity", event: { kind: "model_text", message: "Draft", data: { delta: "Draft answer" } } }
      ] })
      .mockResolvedValueOnce({ running: true, events: [
        { id: 2, type: "activity", event: { kind: "tool_started", message: "Reading", data: { tool: "read_file" } } }
      ] })
      .mockResolvedValueOnce({ running: false, events: [
        { id: 3, type: "completed", result: result("Final answer") }
      ] });
    useAgentStore.getState().sendMessage("Inspect the project", "code");
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.pendingText).toBe("Draft answer"));
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.pendingText).toBe(""));
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.status).toBe("completed"));
    const session = useAgentStore.getState().activeSession()!;
    expect(session.messages.filter((message) => message.content === "Final answer")).toHaveLength(1);
    expect(session.pendingText).toBeUndefined();
  });

  it("marks token-limited output as incomplete instead of successful", async () => {
    api.events.mockResolvedValueOnce({ running: false, events: [
      { id: 1, type: "completed", result: result("Partial output — response incomplete.", "output_incomplete") }
    ] });
    useAgentStore.getState().sendMessage("Build this", "code");
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.status).toBe("incomplete"));
    const session = useAgentStore.getState().activeSession()!;
    expect(session.messages.at(-1)).toMatchObject({ status: "incomplete", content: expect.stringContaining("Partial output") });
  });

  it("does not turn repeated provider reasoning status into fake thought activity", async () => {
    api.events.mockResolvedValueOnce({ running: false, events: [
      { id: 1, type: "activity", event: { kind: "reasoning", message: "PRIVATE MODEL REASONING", data: { delta: "PRIVATE MODEL REASONING" } } },
      { id: 2, type: "completed", result: result("Here is the project overview") }
    ] });
    useAgentStore.getState().sendMessage("Brief me on the project", "code");
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.status).toBe("completed"));
    const session = useAgentStore.getState().activeSession()!;
    expect(session.activity).toEqual([]);
    expect(session.messages.map((message) => message.content).join(" ")).not.toContain("PRIVATE MODEL REASONING");
  });

  it("surfaces service failures and supports cancellation", async () => {
    api.events.mockResolvedValueOnce({ running: false, events: [{ id: 1, type: "failed", error: "Provider unavailable" }] });
    useAgentStore.getState().sendMessage("Do work", "code");
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.status).toBe("failed"));
    expect(useAgentStore.getState().activeSession()?.error).toBe("Provider unavailable");

    useAgentStore.setState({ activeSessionId: "session-1", sessions: [{
      id: "session-1", title: "Task", prompt: "Task", createdAt: Date.now(), updatedAt: Date.now(), durationMs: 0,
      status: "running", messages: [], stages: [], agents: [], activity: [], tools: [],
      context: { repo: "", project: "", filesLoaded: 0, symbolsIndexed: 0, openEditors: 0, selectedContext: "", memoryUsage: 0, contextSize: 0, contextBudget: 1 }, plan: null
    }] });
    useAgentStore.getState().stopTask();
    await vi.waitFor(() => expect(api.stop).toHaveBeenCalledWith("session-1"));
  });

  it("saves provider profiles and switches dock views without resetting the workspace", async () => {
    await useAgentStore.getState().saveProvider({ name: "Local", baseUrl: "https://api.example", model: "model", apiKey: "secret" });
    expect(api.saveProvider).toHaveBeenCalled();
    expect(useAgentStore.getState().selectedProvider).toBe("Local");
    useRightPanelStore.getState().setView("browser");
    expect(useRightPanelStore.getState()).toMatchObject({ open: true, view: "browser" });
    expect(useFileSystemStore.getState().workspace?.path).toBe("C:/work/project");
  });

  it("keeps plan approval pending until the user approves", async () => {
    api.events.mockResolvedValueOnce({ running: false, events: [{ id: 1, type: "completed", result: result("Plan: update files", "awaiting_approval") }] });
    useAgentStore.getState().sendMessage("Make a change", "plan");
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.approvalPending).toBe(true));
    expect(useAgentStore.getState().activeSession()?.approvalType).toBe("plan");
    useAgentStore.getState().approvePlan();
    await vi.waitFor(() => expect(api.approve).toHaveBeenCalledWith("session-1"));
  });

  it("loads saved session history and restores prior tool activity", async () => {
    api.sessions.mockResolvedValue([{ session_id: "saved-session", last_user_message: "Inspect the project", updated_at: "2026-09-30T12:00:00Z" }]);
    api.session.mockResolvedValue({
      session_id: "saved-session", created_at: "2026-09-30T11:00:00Z", updated_at: "2026-09-30T12:00:00Z",
      messages: [
        { role: "user", message_id: "user-1", content: "Inspect the project" },
        { role: "assistant", message_id: "tool-only-1", content: "", tool_calls: [{ id: "tool-list", name: "list_dir", arguments: {} }] },
        { role: "assistant", message_id: "scratch-1", content: "The user said Hello. I should respond appropriately. Let me check the workspace.", tool_calls: [{ id: "tool-1", name: "read_file", arguments: { path: "src/main.ts" } }] },
        { role: "tool", tool_call_id: "tool-1", content: "Read src/main.ts\nChanges:\n--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new" },
        { role: "assistant", message_id: "assistant-1", content: "Hello! How can I help?" }
      ]
    });
    await useAgentStore.getState().loadSessions();
    expect(useAgentStore.getState().history[0]?.id).toBe("saved-session");
    await useAgentStore.getState().openSession("saved-session");
    expect(useAgentStore.getState().activeSession()?.messages.map((message) => message.content)).toEqual(["Inspect the project", "Hello! How can I help?"]);
    expect(useAgentStore.getState().activeSession()?.activity).toHaveLength(2);
    expect(useAgentStore.getState().activeSession()?.activity[1]).toMatchObject({ target: "src/main.ts", status: "completed", diff: expect.stringContaining("+new") });
  });

  it("keeps Agent history isolated when switching workspace folders", async () => {
    api.sessions
      .mockResolvedValueOnce([{ session_id: "folder-a-session", last_user_message: "Folder A", updated_at: "2026-10-01T10:00:00Z" }])
      .mockResolvedValueOnce([{ session_id: "folder-b-session", last_user_message: "Folder B", updated_at: "2026-10-01T11:00:00Z" }]);
    await useAgentStore.getState().loadSessions();
    expect(useAgentStore.getState().history.map((entry) => entry.id)).toEqual(["folder-a-session"]);

    useFileSystemStore.setState({ workspace: { path: "C:/work/another-project", name: "another-project" } });
    await useAgentStore.getState().loadSessions();
    expect(useAgentStore.getState().history.map((entry) => entry.id)).toEqual(["folder-b-session"]);
    expect(useAgentStore.getState().activeSessionId).toBeNull();
    expect(api.sessions).toHaveBeenLastCalledWith("C:/work/another-project");
  });

  it("attaches live file diffs to collapsed write activity", async () => {
    api.events.mockResolvedValueOnce({ running: false, events: [
      { id: 1, type: "activity", event: { kind: "tool_started", message: "Running write_file", data: { tool: "write_file" } } },
      { id: 2, type: "activity", event: { kind: "editing", message: "Updated src/app.ts", data: { file: "src/app.ts", tool: "write_file" } } },
      { id: 3, type: "activity", event: { kind: "file_diff", message: "@@ -1 +1 @@\n-old\n+new", data: { file: "src/app.ts" } } },
      { id: 4, type: "activity", event: { kind: "tool_finished", message: "write_file completed", data: { tool: "write_file", ok: true } } },
      { id: 5, type: "completed", result: result("Updated the file") }
    ] });
    useAgentStore.getState().sendMessage("Update the app", "code");
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.status).toBe("completed"));
    expect(useAgentStore.getState().activeSession()?.activity).toHaveLength(1);
    expect(useAgentStore.getState().activeSession()?.activity[0]).toMatchObject({ kind: "write", target: "src/app.ts", diff: expect.stringContaining("+new") });
  });

  it("keeps workspace and model status messages out of the action timeline", async () => {
    api.events.mockResolvedValueOnce({ running: false, events: [
      { id: 1, type: "activity", event: { kind: "inspecting", message: "Inspecting the workspace…" } },
      { id: 2, type: "activity", event: { kind: "inspecting", message: "Collected workspace inventory" } },
      { id: 3, type: "activity", event: { kind: "selected_model", message: "Using ui_design model profile" } },
      { id: 4, type: "activity", event: { kind: "selected_model", message: "Model responded: example/model" } },
      { id: 5, type: "activity", event: { kind: "tool_started", message: "Running list_dir", data: { tool: "list_dir", path: "src" } } },
      { id: 6, type: "completed", result: result("Here is the project") }
    ] });
    useAgentStore.getState().sendMessage("Tell me about this project", "ask");
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.status).toBe("completed"));
    const session = useAgentStore.getState().activeSession()!;
    expect(session.activity).toHaveLength(1);
    expect(session.activity[0]).toMatchObject({ kind: "read", target: "src" });
  });

  it("keeps thought summaries as collapsible timeline entries between tool actions", async () => {
    api.events.mockResolvedValueOnce({ running: false, events: [
      { id: 1, type: "activity", event: { kind: "thought", message: "I will inspect the entry point first." } },
      { id: 2, type: "activity", event: { kind: "tool_started", message: "Running read_file", data: { tool: "read_file", path: "src/main.ts" } } },
      { id: 3, type: "activity", event: { kind: "thought", message: "The entry point is clear; I can now answer." } },
      { id: 4, type: "completed", result: result("Here is the summary") }
    ] });
    useAgentStore.getState().sendMessage("Summarize the project", "ask");
    await vi.waitFor(() => expect(useAgentStore.getState().activeSession()?.status).toBe("completed"));
    expect(useAgentStore.getState().activeSession()?.activity.map(({ kind, detail }) => [kind, detail])).toEqual([
      ["think", "I will inspect the entry point first."],
      ["read", "Running read_file"],
      ["think", "The entry point is clear; I can now answer."]
    ]);
  });
});
