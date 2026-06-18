#!/usr/bin/env node
// Tests for the npm package: the SHARED cross-engine golden vectors (examples/pricing-vectors.json)
// plus a few API/CLI-shape smoke checks. Zero test framework. Run: node tools/test-npm.mjs
// Rebuilds lib/data.json first so the test always runs against the current dataset.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Ensure the bundle exists and is current before importing the lib (which reads it at module load).
execFileSync('node', [join(ROOT, 'tools', 'build-npm.mjs')], { stdio: 'inherit' });

const { usdForRollup, usdForRollupRaw, priceOn, current, rate, resolve, models, providers } =
	await import('../lib/index.js');

const vectors = JSON.parse(readFileSync(join(ROOT, 'examples', 'pricing-vectors.json'), 'utf8'));

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
	if (cond) {
		pass++;
	} else {
		fail++;
		console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
	}
};

// 1. Golden vectors: every engine must reproduce expected_usd exactly. Vectors are all Claude, so the
//    provider is anthropic (same as Goei's golden.test.ts).
for (const v of vectors.vectors) {
	if (v.expected === 'unknown_model') {
		const { modelKnown } = usdForRollup(v.usage, 'anthropic', v.model, v.at);
		ok(`golden: ${v.name}`, modelKnown === false, `expected unknown, got modelKnown=${modelKnown}`);
		continue;
	}
	const { usd, modelKnown } = usdForRollupRaw(v.usage, 'anthropic', v.model, v.at);
	const { cents } = usdForRollup(v.usage, 'anthropic', v.model, v.at);
	ok(
		`golden: ${v.name}`,
		modelKnown && Math.abs(usd - v.expected_usd) < 1e-6 && cents === Math.round(v.expected_usd * 100),
		`usd=${usd} cents=${cents} expected=${v.expected_usd}`
	);
}

// 2. API shape smoke checks.
const opus = current('claude-opus-4-8');
ok('current resolves opus-4-8', opus && opus.provider === 'anthropic' && opus.input.price_usd === 5);
ok('current carries provenance', !!(opus && opus.input.source && opus.input.confidence));

const aliased = current('claude-opus-4-5');
ok('alias resolves to dated id', aliased && aliased.model === 'claude-opus-4-5-20251101');

const historical = priceOn('claude-opus-4-1-20250805', '2025-09-01');
ok('historical input $15', historical && historical.input.price_usd === 15);

const suffix = current('claude-opus-4-8[1m]');
ok('[1m] suffix tolerated', suffix && suffix.model === 'claude-opus-4-8');

const unknown = priceOn('claude-fantastic-9');
ok('unknown model -> null', unknown === null);

const r = rate('claude-opus-4-8', '2026-06-16');
ok('rate() returns per-million numbers', r && r.inputPerM === 5 && r.outputPerM === 25);

ok('models() non-empty', models().length >= 80);
ok('providers() includes anthropic + openai', providers().includes('anthropic') && providers().includes('openai'));

// Ambiguity: only assert IF the dataset actually has a cross-provider bare-id collision; otherwise
// resolve must not throw. (Guards against a future record introducing one silently.)
let ambiguityHandled = true;
try {
	for (const m of models()) resolve(m.model);
} catch (err) {
	ambiguityHandled = /ambiguous/.test(err.message);
}
ok('resolve() never throws on a canonical id (or throws only the ambiguity error)', ambiguityHandled);

// 3. CLI smoke: exit codes + JSON output.
const cli = (args) => {
	try {
		const out = execFileSync('node', [join(ROOT, 'bin', 'cli.js'), ...args], { encoding: 'utf8' });
		return { code: 0, out };
	} catch (e) {
		return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') };
	}
};
ok('cli: known model exits 0', cli(['claude-opus-4-8']).code === 0);
ok('cli: --json is valid JSON', (() => {
	const { code, out } = cli(['claude-opus-4-8', '--json']);
	try {
		return code === 0 && JSON.parse(out).provider === 'anthropic';
	} catch {
		return false;
	}
})());
ok('cli: unknown model exits 1', cli(['totally-not-a-model']).code === 1);
ok('cli: --version exits 0', cli(['--version']).code === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
