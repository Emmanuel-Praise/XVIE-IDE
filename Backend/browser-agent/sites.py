"""Hardcoded browser-LLM sites for the Xvie browser agent.

Selector tables are ported from the ``mcp-web-llm`` project
(``models/chatgpt.py``, ``claude.py``, ``gemini.py``, ``deepseek.py``,
``grok.py``, ``qwen.py``) so behaviour matches the original adapters while
the automation itself lives in :mod:`engine` as one generic driver.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class BrowserSite:
    id: str
    label: str
    url: str
    domain_keywords: tuple[str, ...]
    input_candidates: tuple[str, ...]
    send_candidates: tuple[str, ...] = ()
    answer_selectors: tuple[str, ...] = ()
    send_key: str = "Enter"
    new_chat_candidates: tuple[str, ...] = (
        "button[aria-label*='New chat' i]",
        "button[title*='New chat' i]",
        "a[aria-label*='New chat' i]",
        "button:has-text('New chat')",
        "button:has-text('New conversation')",
        "a:has-text('New conversation')",
    )


SITES: dict[str, BrowserSite] = {
    "chatgpt": BrowserSite(
        id="chatgpt",
        label="ChatGPT",
        url="https://chatgpt.com/",
        domain_keywords=("chatgpt.com",),
        input_candidates=("#prompt-textarea",),
        send_candidates=(
            # Current markup: morphing composer submit button (no testid).
            "button.composer-submit-button-color",
            'button[data-testid="send-button"]',
            'button[aria-label*="Send" i]',
        ),
        answer_selectors=(
            "div[data-message-author-role='assistant']",
            ".markdown",
        ),
    ),
    "claude": BrowserSite(
        id="claude",
        label="Claude",
        url="https://claude.ai/",
        domain_keywords=("claude.ai",),
        input_candidates=(
            "textarea[data-testid='chat-input-ssr']",
            ".ProseMirror",
            "[contenteditable='true'][role='textbox']",
            "[contenteditable='true']",
            "textarea:not([readonly]):not([aria-hidden='true'])",
        ),
        answer_selectors=(
            ".font-claude-response",
            "div[data-is-streaming='false']",
        ),
    ),
    "gemini": BrowserSite(
        id="gemini",
        label="Gemini",
        url="https://gemini.google.com/",
        domain_keywords=("gemini.google.com",),
        input_candidates=(
            "div[role='textbox'][contenteditable='true']",
            "rich-textarea div[role='textbox']",
            "div[contenteditable='true'][role='textbox']",
            "div[contenteditable='true']",
            "textarea:not([readonly]):not([aria-hidden='true'])",
        ),
        send_candidates=(
            'button[aria-label*="Send" i]',
            'button[aria-label*="message" i]',
            'button[type="submit"]',
        ),
        answer_selectors=(
            "message-content",
            ".model-response-text",
            "model-response",
            "div[class*='response']",
            "div[class*='markdown']",
        ),
    ),
    "deepseek": BrowserSite(
        id="deepseek",
        label="DeepSeek",
        url="https://chat.deepseek.com/",
        domain_keywords=("chat.deepseek.com",),
        input_candidates=(
            "textarea[placeholder*='Message DeepSeek']",
            "textarea#chat-input",
            "textarea[id='chat-input']",
            "textarea[placeholder*='DeepSeek']",
            "textarea",
            "div[contenteditable='true']",
            "div[role='textbox']",
        ),
        send_candidates=(
            # DeepSeek's generic iconLabelPrimary style is also used by the
            # paperclip attachment control, which opens Windows' file picker.
            # Its actual send control is the filled primary circular button.
            "button[aria-label*='send' i]",
            "button[title*='send' i]",
            "button[data-testid*='send' i]",
            "div[role='button'][aria-label*='send' i]",
            "div[role='button'].ds-button--primary.ds-button--filled.ds-button--circle:not(.ds-button--disabled)",
            "button[type='submit']",
        ),
        answer_selectors=(
            ".ds-markdown",
            ".markdown-body",
            "div[class*='markdown']",
            "div[class*='message']",
            "div[class*='assistant']",
        ),
    ),
    "grok": BrowserSite(
        id="grok",
        label="Grok",
        url="https://grok.com/",
        domain_keywords=("grok.com",),
        input_candidates=(
            "textarea[placeholder*='Grok']",
            "textarea[placeholder*='Ask']",
            "textarea",
            "div[contenteditable='true']",
            "div[role='textbox']",
        ),
        answer_selectors=(
            "main div[dir='auto']",
            "main [role='listitem']",
            "main [role='article']",
            ".prose",
            "div[class*='message']",
            "div[class*='markdown']",
        ),
    ),
    "qwen": BrowserSite(
        id="qwen",
        label="Qwen",
        url="https://chat.qwen.ai/",
        domain_keywords=("chat.qwen.ai", "chat.qwenlm.ai", "qwen.ai", "qwenlm.ai"),
        input_candidates=(
            "textarea[class*='ant-input']:not([readonly]):not([aria-hidden='true'])",
            "textarea:not([readonly]):not([aria-hidden='true'])",
            "div[contenteditable='true'][role='textbox']",
            "div[contenteditable='true']",
            "div[role='textbox']",
        ),
        send_candidates=(
            "button[type='submit']",
            "button[aria-label*='send' i]",
        ),
        answer_selectors=(
            ".markdown-body",
            ".qwen-markdown",
            "div[class*='markdown']",
            "div[class*='message']",
            "div[class*='assistant']",
        ),
    ),
    "perplexity": BrowserSite(
        id="perplexity",
        label="Perplexity",
        url="https://www.perplexity.ai/",
        domain_keywords=("perplexity.ai",),
        input_candidates=(
            "textarea[placeholder*='Ask' i]",
            "textarea[placeholder*='Search' i]",
            "textarea:not([readonly]):not([aria-hidden='true'])",
            "div[contenteditable='true'][role='textbox']",
            "div[contenteditable='true']",
            "div[role='textbox']",
        ),
        send_candidates=(
            "button[aria-label*='Submit' i]",
            "button[aria-label*='Send' i]",
            "button[type='submit']",
        ),
        answer_selectors=(
            "div[class*='prose']",
            "div[class*='markdown']",
            "div[class*='answer']",
            "div[data-testid*='answer' i]",
            "main div[class*='message']",
            "main div[class*='assistant']",
        ),
    ),
}

SITE_IDS: tuple[str, ...] = tuple(SITES.keys())

def get_site(site_id: str) -> BrowserSite:
    try:
        return SITES[site_id]
    except KeyError:
        raise ValueError(f"Unknown browser site: {site_id!r}. Expected one of: {', '.join(SITES)}") from None


def site_list() -> list[dict]:
    return [
        {
            "id": s.id,
            "label": s.label,
            "url": s.url,
            "domains": list(s.domain_keywords),
        }
        for s in SITES.values()
    ]
