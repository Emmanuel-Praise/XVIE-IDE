"""End-to-end integration test: design router + system prompt injection."""

from __future__ import annotations

from pathlib import Path

from xvie_agent.design_router import load_references, route
from xvie_agent.design_guidance import (
    inject_core_taste,
    inject_routed_references,
    inject_design_principles,
    scan_project_tokens,
    build_discovery_context,
)
from xvie_agent.tools import build_default_registry, ToolContext


def test_calculator_ui_task_routes_correctly():
    """A calculator UI request should route to relevant design references."""
    result = route("improve the UI of the calculator app")
    print(f"\n[Router] intent={result.intent}")
    print(f"[Router] concepts={result.concepts}")
    print(f"[Router] references:")
    for ref in result.references:
        print(f"  - {ref['name']} (score={ref['score']}, tier={ref['tier']})")
    # 'improve' is a repair marker, so intent=repair is correct
    assert result.intent == "repair"

    # A pure build request with recognizable surface keywords should route normally
    result3 = route("analytics dashboard with KPIs and a data table")
    print(f"\n[Router3] intent={result3.intent}")
    print(f"[Router3] references: {[r['name'] for r in result3.references]}")
    assert len(result3.references) > 0, "Should route to at least one reference"
    assert result3.intent == "build"
    assert result3.references[0]["name"] == "recipe-dashboard"


def test_repair_routing():
    """A janky UI request should route with repair intent."""
    result = route("this calculator button layout is janky, fix it")
    assert result.intent == "repair"
    print(f"\n[Repair] intent={result.intent}")
    print(f"[Repair] references: {[r['name'] for r in result.references]}")


def test_out_of_scope():
    """React Native request should be flagged out of scope."""
    from xvie_agent.design_router import out_of_scope_matches
    result = route("build a calculator for react native")
    oos = out_of_scope_matches("build a calculator for react native")
    assert len(oos) > 0
    assert oos[0]["id"] == "native-mobile"
    print(f"\n[Out of scope] {oos[0]['label']}: {oos[0]['use']}")


def test_system_prompt_injection():
    """Design system is injected into the system prompt for UI tasks."""
    base_prompt = "You are xvie-agent, an AI coding assistant."

    # Should inject for UI role
    result = inject_design_principles(base_prompt, "ui_design", "")
    assert "UI Design System" in result or "Core Taste" in result
    print(f"\n[Injection] UI role -> design system injected ({len(result)} chars)")

    # Should inject for UI keyword in prompt
    result = inject_design_principles(base_prompt, "", "improve the calculator styling")
    assert "UI Design System" in result or "Core Taste" in result
    print(f"[Injection] UI keyword -> design system injected ({len(result)} chars)")

    # Should NOT inject for non-UI task
    result = inject_design_principles(base_prompt, "coding", "sort a list in python")
    assert "UI Design System" not in result
    assert result == base_prompt
    print(f"[Injection] Non-UI -> no injection")


def test_routed_references_injection():
    """Routed references are injected into the system prompt."""
    base_prompt = "You are xvie-agent."
    routed = load_references("dashboard with KPIs and charts", limit=4)

    result = inject_routed_references(base_prompt, routed)
    assert len(result) > len(base_prompt)
    assert "Router decision" in result
    assert "Loaded references" in result
    print(f"\n[Routed refs] {len(routed['loaded'])} references injected")
    for ref in routed["loaded"]:
        print(f"  - {ref['path']} ({len(ref['content'])} chars)")


def test_discovery():
    """Discovery scans the project for tokens."""
    calc_dir = Path(__file__).parent.parent / "work" / "calculator"
    if calc_dir.exists():
        signals = scan_project_tokens(calc_dir)
        ctx = build_discovery_context(signals)
        print(f"\n[Discovery] has_tokens={signals.get('has_tokens')}")
        print(f"[Discovery] inventory={signals.get('inventory', {})}")
        print(f"[Discovery] context: {ctx[:100]}...")
    else:
        print("\n[Discovery] calculator directory not found, skipping")


def test_read_ui_reference_tool():
    """The read_ui_reference tool resolves references correctly."""
    ctx = ToolContext(workspace_root=Path("."), allow_write=False, allow_shell=False)
    tools = build_default_registry(ctx)
    assert "read_ui_reference" in tools
    print(f"\n[Tool] read_ui_reference registered ({len(tools)} total tools)")

    # Test it resolves known references
    handler = tools["read_ui_reference"].handler
    result = handler({"name": "forms"}, ctx)
    assert result.ok
    assert "validation" in result.content.lower()
    print(f"[Tool] read_ui_reference('forms') -> {len(result.content)} chars")

    # Test path traversal is rejected
    result = handler({"name": "../package.json"}, ctx)
    assert not result.ok
    print(f"[Tool] read_ui_reference('../package.json') -> rejected")


def test_full_assembly():
    """Full system prompt assembly mimicking the agent loop."""
    base_prompt = "You are xvie-agent, an AI coding assistant with tools."
    user_request = "improve the styling and layout of my calculator app"

    # Layer 1: Core taste
    prompt = inject_core_taste(base_prompt)
    print(f"\n[Full] Layer 1 (core taste): {len(prompt)} chars")

    # Layer 2: Routed references
    routed = load_references(user_request, limit=4)
    prompt = inject_routed_references(prompt, routed)
    print(f"[Full] Layer 2 (routed refs): {len(prompt)} chars, {len(routed['loaded'])} files loaded")

    # Layer 3: Discovery
    calc_dir = Path(__file__).parent.parent / "work" / "calculator"
    signals = scan_project_tokens(calc_dir) if calc_dir.exists() else None
    discovery = build_discovery_context(signals)
    prompt += f"\n\n{discovery}"
    print(f"[Full] Layer 3 (discovery): {len(prompt)} chars total")

    # Summary
    print(f"\n{'='*60}")
    print(f"Final system prompt: {len(prompt)} chars")
    print(f"Router intent: {routed['intent']}")
    print(f"References loaded: {[r['path'] for r in routed['loaded']]}")
    print(f"Always-load (unloaded tier-1): {routed['always_load']}")
    print(f"Out of scope: {routed['out_of_scope']}")
    print(f"{'='*60}")


if __name__ == "__main__":
    test_calculator_ui_task_routes_correctly()
    test_repair_routing()
    test_out_of_scope()
    test_system_prompt_injection()
    test_routed_references_injection()
    test_discovery()
    test_read_ui_reference_tool()
    test_full_assembly()
    print("\nAll integration tests passed!")
