/** Return model text safe to show while it is still streaming. */
export function visibleAgentDraft(text: string | undefined): string {
  if (!text?.trim()) return "";
  const trimmed = text.trimStart();
  // Tool-capable providers sometimes stream the JSON fallback protocol as
  // ordinary text. Keep it out of the conversation until it is parsed.
  if (/^(?:```json\s*)?[\[{]/i.test(trimmed) || /^<\|(?:im_start|tool_calls_section_begin)\|>/i.test(trimmed)) {
    return "";
  }
  return text;
}
