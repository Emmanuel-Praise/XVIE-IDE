import { describe, expect, it } from "vitest";
import { AGENT_MODES, getModeInfo } from "../src/Agent/data/modes";

describe("Xvie Agent modes", () => {
  it("exposes all five backend modes in the prompt selector", () => {
    expect(AGENT_MODES.map((mode) => mode.id)).toEqual(["plan", "ask", "code", "debug", "brainstorm"]);
  });

  it("describes Brainstorm and safely defaults unknown persisted values to Code", () => {
    expect(getModeInfo("brainstorm").label).toBe("Brainstorm");
    expect(getModeInfo("code").id).toBe("code");
  });
});
