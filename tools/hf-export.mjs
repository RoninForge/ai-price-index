#!/usr/bin/env node
// Builds the Hugging Face dataset mirror from data/records/*.json.
// Output: dist/hf/ai_price_index.csv (load_dataset-able) + dist/hf/ai_price_index.json (raw).
// Run: node tools/hf-export.mjs
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const recDir = join(root, 'data', 'records');
const outDir = join(root, 'dist', 'hf');
mkdirSync(outDir, { recursive: true });

const COLS = [
	'provider',
	'model_id',
	'variation',
	'unit',
	'price_usd',
	'effective_from',
	'effective_to',
	'last_validated_at',
	'source_kind',
	'confidence',
	'aliases',
	'source_url',
	'notes'
];

const rows = [];
for (const f of readdirSync(recDir).filter((f) => f.endsWith('.json')).sort()) {
	const recs = JSON.parse(readFileSync(join(recDir, f), 'utf8'));
	for (const r of recs) rows.push(r);
}

// Stable sort: provider, model_id, variation, effective_from.
rows.sort(
	(a, b) =>
		a.provider.localeCompare(b.provider) ||
		a.model_id.localeCompare(b.model_id) ||
		a.variation.localeCompare(b.variation) ||
		String(a.effective_from).localeCompare(String(b.effective_from))
);

const csvCell = (v) => {
	if (v === null || v === undefined) return '';
	const s = Array.isArray(v) ? v.join('; ') : String(v);
	return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

const csv = [
	COLS.join(','),
	...rows.map((r) => COLS.map((c) => csvCell(r[c])).join(','))
].join('\n');

writeFileSync(join(outDir, 'ai_price_index.csv'), csv + '\n');
writeFileSync(join(outDir, 'ai_price_index.json'), JSON.stringify(rows, null, 2) + '\n');

const providers = new Set(rows.map((r) => r.provider));
const models = new Set(rows.map((r) => r.provider + '/' + r.model_id));
console.log(
	`rows=${rows.length}  providers=${providers.size}  models=${models.size}  -> dist/hf/`
);
