"""Tests for xvie_agent.redact — secret redaction, no false positives."""

from __future__ import annotations

from xvie_agent.redact import redact_secrets


class TestOpenAIKeys:
    def test_openai_api_key(self) -> None:
        text = "OPENAI_API_KEY=sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx"
        result = redact_secrets(text)
        assert "sk-proj-abc123" not in result
        assert "[REDACTED]" in result

    def test_short_sk_not_redacted(self) -> None:
        """Short sk- strings that look like prefixes shouldn't be redacted."""
        text = "skill = 42"
        result = redact_secrets(text)
        assert "skill" in result


class TestOpenRouterKeys:
    def test_openrouter_key(self) -> None:
        token = "sk-or-v1-" + ("a" * 64)
        text = token
        result = redact_secrets(text)
        assert token not in result
        assert "[REDACTED]" in result


class TestAWSKeys:
    def test_aws_access_key(self) -> None:
        text = "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE"
        result = redact_secrets(text)
        assert "AKIAIOSFODNN7EXAMPLE" not in result
        assert "[REDACTED]" in result


class TestGitHubTokens:
    def test_ghp_token(self) -> None:
        text = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"
        result = redact_secrets(text)
        assert "ghp_ABCDEF" not in result
        assert "[REDACTED]" in result

    def test_gho_token(self) -> None:
        text = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"
        result = redact_secrets(text)
        assert "gho_ABCDEF" not in result
        assert "[REDACTED]" in result

    def test_ghu_token(self) -> None:
        text = "ghu_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"
        result = redact_secrets(text)
        assert "ghu_ABCDEF" not in result
        assert "[REDACTED]" in result

    def test_ghr_token(self) -> None:
        text = "ghr_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn"
        result = redact_secrets(text)
        assert "ghr_ABCDEF" not in result
        assert "[REDACTED]" in result


class TestGoogleKeys:
    def test_google_api_key(self) -> None:
        text = "api_key=AIzaSyDExample1234567890abcdefghijklmnopq"
        result = redact_secrets(text)
        assert "AIzaSyDExample" not in result
        assert "[REDACTED]" in result


class TestBearerTokens:
    def test_bearer_token(self) -> None:
        text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.signature'
        result = redact_secrets(text)
        assert "eyJhbGci" not in result
        assert "Bearer [REDACTED]" in result


class TestVariableAssignedSecrets:
    def test_api_key_equals(self) -> None:
        text = 'MY_API_KEY = "abc123def456ghi789jkl012mno345"'
        result = redact_secrets(text)
        assert "abc123def456" not in result
        assert "[REDACTED]" in result

    def test_secret_assignment(self) -> None:
        text = 'DATABASE_SECRET="SuperSecretValue123456789012345678"'
        result = redact_secrets(text)
        assert "SuperSecretValue" not in result

    def test_token_env_var(self) -> None:
        token = "-".join(("xoxb", "1" * 10, "2" * 13, "a" * 22))
        text = f"SLACK_TOKEN={token}"
        result = redact_secrets(text)
        assert token not in result
        assert "[REDACTED]" in result

    def test_password_assignment(self) -> None:
        text = "DB_PASSWORD=postgres123supersecret!!"
        result = redact_secrets(text)
        assert "postgres123supersecret" not in result


class TestHexBlobRedaction:
    def test_32_char_hex_blob(self) -> None:
        text = "hash: 0123456789abcdef0123456789abcdef"
        result = redact_secrets(text)
        assert "0123456789abcdef" not in result
        assert "[REDACTED]" in result


class TestFalsePositives:
    """Normal code should NOT be falsely redacted."""

    def test_page_size(self) -> None:
        text = "page_size = 20"
        result = redact_secrets(text)
        assert "page_size" in result
        assert "20" in result

    def test_function_name(self) -> None:
        text = "def get_user_token(): pass"
        result = redact_secrets(text)
        assert "get_user_token" in result

    def test_comment_with_api_in_name(self) -> None:
        text = "# This calls the API endpoint"
        result = redact_secrets(text)
        assert "API endpoint" in result

    def test_short_hex(self) -> None:
        text = "color = #ff0000"
        result = redact_secrets(text)
        assert "#ff0000" in result

    def test_normal_string_assignment(self) -> None:
        text = 'GREETING = "hello world"'
        result = redact_secrets(text)
        assert "hello world" in result

    def test_import_statement(self) -> None:
        text = "import os"
        result = redact_secrets(text)
        assert "import os" in result

    def test_integer_assignment(self) -> None:
        text = "MAX_RETRIES = 42"
        result = redact_secrets(text)
        assert "42" in result

    def test_normal_variable_names(self) -> None:
        text = "user_name = 'John'\napi_version = 'v2'"
        result = redact_secrets(text)
        assert "John" in result
        assert "v2" in result


class TestEdgeCases:
    def test_empty_string(self) -> None:
        assert redact_secrets("") == ""

    def test_multiple_secrets(self) -> None:
        text = "key1=sk-proj-abc123def456ghi789jkl012mno345pqr678stu901vwx\nkey2=AKIAIOSFODNN7EXAMPLE"
        result = redact_secrets(text)
        assert "[REDACTED]" in result
        # Both secrets should be redacted
        assert result.count("[REDACTED]") >= 2

    def test_no_false_positive_on_sk_prefix(self) -> None:
        """'skill', 'skip', etc. contain 'sk' but aren't secrets."""
        text = "She has a skill for Python.\nI'll skip this step."
        result = redact_secrets(text)
        assert "skill" in result
        assert "skip" in result
