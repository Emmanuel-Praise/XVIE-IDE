"""Smoke tests for project scaffolding."""

import pytest

from xvie_agent import __version__
from xvie_agent.cli import main
from xvie_agent.config import Config, load_config


def test_version_exists():
    assert isinstance(__version__, str)
    assert __version__ == "0.1.0"


def test_cli_version(capsys):
    with pytest.raises(SystemExit) as exc_info:
        main(["--version"])
    assert exc_info.value.code == 0
    captured = capsys.readouterr()
    assert "xvie-agent" in captured.out or "xvie-agent" in captured.err
    assert "0.1.0" in captured.out or "0.1.0" in captured.err


def test_cli_help(capsys):
    with pytest.raises(SystemExit) as exc_info:
        main(["--help"])
    assert exc_info.value.code == 0


def test_config_defaults():
    config = Config()
    assert config.default_model == "nvidia/nemotron-3-ultra-550b-a55b"
    assert config.max_turns == 50
    assert config.budget_tokens == 100_000


def test_load_config_no_env(tmp_path, monkeypatch):
    fake_env = tmp_path / ".env"
    fake_env.write_text("")
    monkeypatch.delenv("MAX_TURNS", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("NVIDIA_BASE_URL", raising=False)
    monkeypatch.delenv("FORGE_PROVIDER_NVIDIA_API_KEY", raising=False)
    monkeypatch.delenv("FORGE_PROVIDER_NVIDIA_BASE_URL", raising=False)
    config = load_config(env_file=str(fake_env))
    assert isinstance(config, Config)
    assert config.max_turns == 50

