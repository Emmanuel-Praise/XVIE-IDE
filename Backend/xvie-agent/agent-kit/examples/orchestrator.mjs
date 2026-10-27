/**
 * orchestrator.mjs — example wiring for a custom agentic system.
 *
 * Shows the full 3-layer integration:
 *   Layer 1  system-prompt-core.md          → always-on taste (prepend to your system prompt)
 *   Layer 2  router (route/loadReferences)  → pre-loads top references per request
 *   Layer 3  Discovery                      → project scan / Quick Ask before generating
 *
 * The `callLLM` function is a stub — replace with your model client. Everything else
 * runs as-is: `node orchestrator.mjs "analytics panel with KPIs and a data table"`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadReferences, listReferences, readReference, route } from '../router/route.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ─── Layer 1: always-on system prompt ────────────────────────────────────────

const corePrompt = readFileSync(resolve(KIT_ROOT, 'system-prompt-core.md'), 'utf8');
const routingTable = readFileSync(resolve(KIT_ROOT, 'routing-table.md'), 'utf8');

function buildSystemPrompt({ routed }) {
  return [
    corePrompt,
    routingTable,
    // Per-request context block: what the router decided and the files it loaded.
    `## Router decision for this request\n\n${routed.instruction}`,
    routed.out_of_scope.length
      ? `\nOut of scope for this request: ${routed.out_of_scope.map((o) => o.label).join(', ')}.`
      : '',
    '\n## Loaded references\n',
    ...routed.loaded.map((ref) => `\n<!-- ${ref.path} -->\n\n${ref.content}\n`),
  ].join('\n');
}

// ─── Layer 2: per-request context assembly ───────────────────────────────────

function buildContext(userRequest) {
  const routed = loadReferences(userRequest, { limit: 4 });
  return { system: buildSystemPrompt({ routed }), routed };
}

// ─── Layer 2b: the read tool your agent can call mid-task ────────────────────

const readTool = {
  name: 'read_ui_reference',
  description:
    'Read a ui-craft design reference by name. Consult the routing table in your instructions; ' +
    'call this when the current task matches a reference that was not pre-loaded.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: `One of: ${listReferences().map((r) => r.name).join(', ')}`,
      },
    },
    required: ['name'],
  },
  run: ({ name }) => readReference(name).content,
};

// ─── Layer 3: discovery hook ─────────────────────────────────────────────────
// Run before generation. If the user's project has tokens/fonts, inventory them and
// inject as constraints. Otherwise ask the Quick Ask once and cache the answers.

function discoveryContext(projectSignals) {
  if (!projectSignals || !projectSignals.hasTokens) {
    return 'DISCOVERY: no token system detected. Ask the Quick Ask before building: style? accent color? font? animation library? Apply knob defaults only if the user declines to specify.';
  }
  return `DISCOVERY: project tokens found — respect them. Inventory: ${JSON.stringify(projectSignals.inventory)}`;
}

// ─── Stub: your LLM call ─────────────────────────────────────────────────────

async function callLLM({ system, messages, tools }) {
  // Replace with your client, e.g.:
  //   return anthropic.messages.create({ model, max_tokens, system, messages, tools });
  console.error('[stub] would call LLM with', {
    systemChars: system.length,
    messages: messages.length,
    tools: tools.map((t) => t.name),
  });
  return { text: '[stub] LLM output goes here' };
}

// ─── Wire it together ────────────────────────────────────────────────────────

async function handleUserRequest(userRequest, projectSignals) {
  const { system, routed } = buildContext(userRequest);
  const fullSystem = `${system}\n\n${discoveryContext(projectSignals)}`;

  console.error(`[router] intent=${routed.intent} concepts=[${routed.concepts.join(', ')}]`);
  console.error(`[router] pre-loaded: ${routed.loaded.map((r) => r.path).join(', ') || '(none)'}`);
  console.error(`[router] tier-1 must-reads appended: ${routed.always_load.join(', ') || '(none)'}`);
  if (routed.out_of_scope.length) {
    console.error(`[router] OUT OF SCOPE: ${routed.out_of_scope.map((o) => o.label).join(', ')}`);
  }

  const reply = await callLLM({
    system: fullSystem,
    messages: [{ role: 'user', content: userRequest }],
    tools: [readTool],
  });
  return reply;
}

// Also export the pieces for embedding in your own orchestration.
export { buildContext, buildSystemPrompt, readTool, discoveryContext, route, listReferences, readReference };

// CLI smoke run: `node orchestrator.mjs "<request>"`
const request = process.argv[2];
if (request) {
  const reply = await handleUserRequest(request, { hasTokens: false });
  console.log(reply.text ?? JSON.stringify(reply));
}
