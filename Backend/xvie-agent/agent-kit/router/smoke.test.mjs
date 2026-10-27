/**
 * smoke.test.mjs — verifies the agent-kit router.
 * Run: node smoke.test.mjs  (exit 0 = pass)
 */

import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { route, loadReferences, listReferences, readReference, isRepairIntent } from './route.mjs';
import { CORPUS } from './route-data.mjs';

const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 1. Every corpus path exists on disk.
for (const entry of CORPUS) {
  assert.ok(existsSync(resolve(KIT_ROOT, entry.path)), `missing file: ${entry.path}`);
}
console.log(`ok  all ${CORPUS.length} corpus paths resolve`);

// 2. Signature routings land on the right recipe.
assert.equal(route('analytics panel with KPIs').references[0].name, 'recipe-dashboard');
console.log('ok  "analytics panel with KPIs" -> recipe-dashboard');

assert.equal(route('pricing block with testimonials').references[0].name, 'recipe-landing');
console.log('ok  "pricing block with testimonials" -> recipe-landing');

assert.ok(route('sign-up page with magic link').references.some((r) => r.name === 'recipe-auth'));
console.log('ok  "sign-up page with magic link" -> includes recipe-auth');

assert.ok(
  route('multi-step checkout wizard with autosave').references.some((r) => r.name === 'forms'),
  'forms should surface for wizard/checkout'
);
console.log('ok  "checkout wizard with autosave" -> forms');

assert.ok(
  route('chat streaming surface with citations').references.some((r) => r.name === 'ai-chat'),
  'ai-chat should surface for streaming/citations'
);
console.log('ok  "chat streaming with citations" -> ai-chat');

// 3. Repair intent detection + suppression of build framing.
assert.equal(isRepairIntent('this modal is janky, fix it'), true);
assert.equal(isRepairIntent('build me a modal'), false);
const repair = route('this data table is slow, fix it');
assert.equal(repair.intent, 'repair');
console.log('ok  repair intent detected for "this data table is slow"');

// 4. Out-of-scope detection is additive (routing still runs).
const oos = route('landing page for our react native app');
assert.deepEqual(oos.out_of_scope.map((o) => o.id), ['native-mobile']);
assert.ok(oos.references.length > 0, 'routing still returns references');
console.log('ok  out-of-scope flag on "react native" while routing continues');

// 5. Empty / garbage prompts report honestly instead of guessing.
assert.equal(route('').instruction.includes('Empty prompt'), true);
assert.equal(route('the the the').references.length, 0);
// Concepts survive tokenization but nothing clears the noise floor — must return the
// no-match instruction, not crash on scored[0] (regression: promotion-block guard).
const noHit = route('make a settings screen');
assert.equal(noHit.references.length, 0);
assert.ok(noHit.instruction.includes('Nothing matched'), 'zero-hit prompt reports honestly');
console.log('ok  empty, stopword-only and zero-hit prompts route to nothing without crashing');

// 6. Context budget: ranked refs read in full; craft-intent appended with a recipe;
//    remaining tier-1 stays as pointers, not content.
const narrow = loadReferences('fix a button hover state', { limit: 2 });
assert.ok(narrow.loaded.length > 0, 'ranked references should be loaded');
assert.ok(narrow.always_load.length > 0, 'unloaded tier-1 remains as pointers');
assert.ok(narrow.loaded.every((r) => typeof r.content === 'string' && r.content.length > 100));
const recipeLoad = loadReferences('analytics panel with KPIs', { limit: 3 });
assert.ok(
  recipeLoad.loaded.some((r) => r.path === 'references/craft-intent.md'),
  'craft-intent is appended when a surface recipe loads'
);
assert.ok(
  recipeLoad.loaded.some((r) => r.path === 'references/layout.md'),
  'layout.md is appended when a surface recipe loads'
);
console.log(`ok  loadReferences reads files (${recipeLoad.loaded.length} loaded, budget respected)`);

// 7. read tool accessors: by name, by path; traversal rejected.
assert.ok(readReference('forms').content.includes('validation'));
assert.ok(readReference('references/forms.md').content.length > 0);
assert.throws(() => readReference('../package.json'), /escapes the kit directory/);
assert.equal(listReferences().length, CORPUS.length);
console.log('ok  readReference/listReferences behave, traversal blocked');

// 8. Determinism: same input, same output twice.
assert.deepEqual(JSON.stringify(route('dashboard')), JSON.stringify(route('dashboard')));
console.log('ok  routing is deterministic');

console.log('\nALL SMOKE TESTS PASSED');
