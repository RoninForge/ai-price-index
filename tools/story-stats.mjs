#!/usr/bin/env node
// Ad-hoc analysis to find the data stories in data/records/*.json.
// Read-only; prints findings. Not part of the build. Safe to delete.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const recDir = join(root, 'data', 'records');

const rows = [];
for (const f of readdirSync(recDir).filter((f) => f.endsWith('.json')).sort()) {
	for (const r of JSON.parse(readFileSync(join(recDir, f), 'utf8'))) rows.push(r);
}

const providers = new Set(rows.map((r) => r.provider));
const models = new Set(rows.map((r) => r.provider + '/' + r.model_id));
const dates = rows.map((r) => r.effective_from).filter(Boolean).sort();

console.log('=== OVERVIEW ===');
console.log('records:', rows.length, 'providers:', providers.size, 'models:', models.size);
console.log('effective_from span:', dates[0], '->', dates[dates.length - 1]);
console.log('providers:', [...providers].join(', '));

// Same-model_id repricings = a real price CHANGE on the same SKU (the "receipts").
console.log('\n=== SAME-SKU REPRICINGS (same provider+model_id+variation, >1 price point) ===');
const byKey = new Map();
for (const r of rows) {
	const k = `${r.provider}|${r.model_id}|${r.variation}`;
	if (!byKey.has(k)) byKey.set(k, []);
	byKey.get(k).push(r);
}
const repricings = [];
for (const [k, arr] of byKey) {
	const priced = arr.slice().sort((a, b) => String(a.effective_from).localeCompare(String(b.effective_from)));
	const distinctPrices = new Set(priced.map((r) => r.price_usd));
	if (priced.length > 1 && distinctPrices.size > 1) {
		const first = priced[0], last = priced[priced.length - 1];
		const pct = ((last.price_usd - first.price_usd) / first.price_usd) * 100;
		repricings.push({ k, first, last, pct, n: priced.length });
	}
}
repricings.sort((a, b) => a.pct - b.pct);
for (const x of repricings) {
	console.log(
		`${x.k}: ${x.first.price_usd} (${x.first.effective_from}) -> ${x.last.price_usd} (${x.last.effective_from})  ${x.pct.toFixed(0)}%  [${x.n} points]`
	);
}
if (!repricings.length) console.log('(none: prices are tracked per model generation, not per-SKU repricing)');

// Per-provider generational trajectory for INPUT prices (current rows only).
console.log('\n=== CURRENT INPUT PRICES BY PROVIDER (effective_to null), sorted ===');
const current = rows.filter((r) => r.effective_to === null || r.effective_to === undefined);
const curInput = current.filter((r) => r.variation === 'input').sort((a, b) => a.price_usd - b.price_usd);
const curOutput = current.filter((r) => r.variation === 'output').sort((a, b) => a.price_usd - b.price_usd);
console.log('cheapest current input:', curInput.slice(0, 5).map((r) => `${r.provider}/${r.model_id}=${r.price_usd}`).join('  '));
console.log('priciest current input:', curInput.slice(-5).map((r) => `${r.provider}/${r.model_id}=${r.price_usd}`).join('  '));
console.log('cheapest current output:', curOutput.slice(0, 5).map((r) => `${r.provider}/${r.model_id}=${r.price_usd}`).join('  '));
console.log('priciest current output:', curOutput.slice(-5).map((r) => `${r.provider}/${r.model_id}=${r.price_usd}`).join('  '));
const inLo = curInput[0], inHi = curInput[curInput.length - 1];
console.log(`current INPUT spread: ${inHi.price_usd} / ${inLo.price_usd} = ${(inHi.price_usd / inLo.price_usd).toFixed(0)}x`);
const outLo = curOutput[0], outHi = curOutput[curOutput.length - 1];
console.log(`current OUTPUT spread: ${outHi.price_usd} / ${outLo.price_usd} = ${(outHi.price_usd / outLo.price_usd).toFixed(0)}x`);

// Records carrying editorial notes (human context about cuts / launches).
console.log('\n=== NOTES (editorial context already in the data) ===');
for (const r of rows) {
	if (r.notes) console.log(`- ${r.provider}/${r.model_id} ${r.variation}@${r.price_usd} (${r.effective_from}): ${r.notes}`);
}

// Models per provider + earliest/latest per provider.
console.log('\n=== PER-PROVIDER COVERAGE ===');
for (const p of [...providers].sort()) {
	const pr = rows.filter((r) => r.provider === p);
	const pm = new Set(pr.map((r) => r.model_id));
	const pd = pr.map((r) => r.effective_from).filter(Boolean).sort();
	console.log(`${p}: ${pm.size} models, ${pr.length} records, ${pd[0]} -> ${pd[pd.length - 1]}`);
}
