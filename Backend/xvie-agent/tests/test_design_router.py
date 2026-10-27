"""Tests for the Python design router — mirrors the JS smoke test assertions."""

from __future__ import annotations

import pytest

from xvie_agent.design_router import (
    CORPUS,
    RouteResult,
    edit_distance,
    get_reference_names,
    is_repair_intent,
    list_references,
    load_references,
    out_of_scope_matches,
    read_reference,
    route,
    stem,
    tokenize,
    to_concepts,
)


class TestTokenizeAndStem:
    def test_tokenize_basic(self):
        tokens = tokenize("analytics panel with KPIs")
        assert "analytics" in tokens
        assert "panel" in tokens
        assert "kpis" in tokens

    def test_tokenize_stopwords_removed(self):
        tokens = tokenize("build me a dashboard")
        assert "build" not in tokens  # "build" is a stopword
        assert "dashboard" in tokens

    def test_stem_ing(self):
        assert stem("building") == "build"

    def test_stem_s(self):
        assert stem("dashboards") == "dashboard"

    def test_edit_distance_same(self):
        assert edit_distance("hello", "hello") == 0

    def test_edit_distance_close(self):
        assert edit_distance("hello", "helo") == 1


class TestRepairIntent:
    def test_repair_janky(self):
        assert is_repair_intent("this modal is janky, fix it") is True

    def test_repair_slow(self):
        assert is_repair_intent("this data table is slow, fix it") is True

    def test_not_repair_build(self):
        assert is_repair_intent("build me a modal") is False

    def test_not_repair_normal(self):
        assert is_repair_intent("create a dashboard with KPIs") is False


class TestRoute:
    def test_analytics_to_dashboard(self):
        result = route("analytics panel with KPIs")
        assert result.references[0]["name"] == "recipe-dashboard"

    def test_pricing_to_landing(self):
        result = route("pricing block with testimonials")
        assert result.references[0]["name"] == "recipe-landing"

    def test_signup_to_auth(self):
        result = route("sign-up page with magic link")
        names = [r["name"] for r in result.references]
        assert "recipe-auth" in names

    def test_checkout_to_forms(self):
        result = route("multi-step checkout wizard with autosave")
        names = [r["name"] for r in result.references]
        assert "forms" in names

    def test_chat_to_ai_chat(self):
        result = route("chat streaming surface with citations")
        names = [r["name"] for r in result.references]
        assert "ai-chat" in names

    def test_repair_intent(self):
        result = route("this data table is slow, fix it")
        assert result.intent == "repair"

    def test_out_of_scope_react_native(self):
        result = route("landing page for our react native app")
        oos_ids = [o["id"] for o in result.out_of_scope]
        assert "native-mobile" in oos_ids
        # Routing still returns references
        assert len(result.references) > 0

    def test_empty_prompt(self):
        result = route("")
        assert "Empty prompt" in result.instruction

    def test_stopword_only(self):
        result = route("the the the")
        assert len(result.references) == 0

    def test_deterministic(self):
        r1 = route("dashboard")
        r2 = route("dashboard")
        assert r1.concepts == r2.concepts
        assert r1.intent == r2.intent
        assert len(r1.references) == len(r2.references)

    def test_spring_animation_to_motion(self):
        result = route("add spring animation to the modal")
        names = [r["name"] for r in result.references]
        assert "motion" in names

    def test_3d_globe_to_stack(self):
        result = route("3d globe hero with cobe")
        names = [r["name"] for r in result.references]
        assert "stack" in names

    def test_drawer_to_components(self):
        result = route("bottom drawer sheet with sonner toaster")
        names = [r["name"] for r in result.references]
        assert "components" in names


class TestLoadReferences:
    def test_loads_content(self):
        result = load_references("analytics panel with KPIs", limit=3)
        assert len(result["loaded"]) > 0
        for ref in result["loaded"]:
            assert "content" in ref
            assert len(ref["content"]) > 100

    def test_recipe_is_loaded_without_broad_pins(self):
        result = load_references("analytics panel with KPIs", limit=3)
        paths = [r["path"] for r in result["loaded"]]
        assert paths[0] == "references/recipe-dashboard.md"
        assert "references/craft-intent.md" not in paths

    def test_default_load_is_compact_and_relevant(self):
        result = load_references("landing page for a bag store")
        assert len(result["loaded"]) <= 2
        assert sum(len(ref["content"]) for ref in result["loaded"]) <= 12_000
        assert result["loaded"][0]["name"] == "recipe-landing"
        assert "references/page-completeness.md" not in {
            ref["path"] for ref in result["loaded"]
        }


class TestReadReference:
    def test_read_by_name(self):
        ref = read_reference("forms")
        assert "content" in ref
        assert "validation" in ref["content"].lower()

    def test_read_by_path(self):
        ref = read_reference("references/forms.md")
        assert ref["content"]

    def test_traversal_rejected(self):
        with pytest.raises(ValueError, match="escapes the kit directory"):
            read_reference("../package.json")

    def test_unknown_name(self):
        with pytest.raises(FileNotFoundError):
            read_reference("nonexistent-reference")


class TestListReferences:
    def test_list_count(self):
        refs = list_references()
        assert len(refs) == len(CORPUS)

    def test_get_reference_names(self):
        names = get_reference_names()
        assert "forms" in names
        assert "dashboard" in names
        assert len(names) == len(CORPUS)
