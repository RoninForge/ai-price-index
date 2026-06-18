#!/usr/bin/env node
// Packs the Kaggle upload bundle into dist/kaggle/ from the Hugging Face export.
// The CSV/JSON are identical to the HF mirror (one flat table), so this reuses dist/hf/*.
// Run: node tools/hf-export.mjs && node tools/kaggle-pack.mjs
//
// Output (dist/kaggle/, gitignored):
//   ai_price_index.csv      the data (drag into the Kaggle web UI, or `kaggle datasets create -p`)
//   ai_price_index.json     the same records as JSON
//   description.md          rendered description (paste into the web form's description field)
//   dataset-metadata.json   for the optional Kaggle CLI path (set the id to <your-username>/ai-price-index)
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const hfDir = join(root, 'dist', 'hf');
const outDir = join(root, 'dist', 'kaggle');

const csv = join(hfDir, 'ai_price_index.csv');
const json = join(hfDir, 'ai_price_index.json');
if (!existsSync(csv) || !existsSync(json)) {
	console.error('Missing dist/hf exports. Run `node tools/hf-export.mjs` first.');
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// Live counts from the flat rows (kept consistent with what ships in the CSV).
const rows = JSON.parse(readFileSync(json, 'utf8'));
const records = rows.length;
const models = new Set(rows.map((r) => `${r.provider}/${r.model_id}`)).size;
const providers = new Set(rows.map((r) => r.provider)).size;

const description = readFileSync(join(root, 'tools', 'kaggle', 'description.md'), 'utf8')
	.replaceAll('{{RECORDS}}', String(records))
	.replaceAll('{{MODELS}}', String(models))
	.replaceAll('{{PROVIDERS}}', String(providers));

copyFileSync(csv, join(outDir, 'ai_price_index.csv'));
copyFileSync(json, join(outDir, 'ai_price_index.json'));
writeFileSync(join(outDir, 'description.md'), description);

// Kaggle CLI metadata. `id` must be <kaggle-username>/<slug>; left as a placeholder to fill in.
const metadata = {
	title: 'AI Price Index',
	id: 'INSERT_KAGGLE_USERNAME/ai-price-index',
	subtitle: 'Dated, first-party-sourced AI model API prices over time',
	description,
	licenses: [{ name: 'CC-BY-4.0' }],
	keywords: [
		'artificial intelligence',
		'nlp',
		'large language models',
		'finance',
		'business',
		'economics'
	],
	resources: [
		{
			path: 'ai_price_index.csv',
			description: 'One row per model and variation (input/output) per dated validity window'
		},
		{ path: 'ai_price_index.json', description: 'The same price records as JSON' }
	]
};
writeFileSync(join(outDir, 'dataset-metadata.json'), JSON.stringify(metadata, null, 2) + '\n');

console.log(`Packed dist/kaggle/  (${records} records, ${models} models, ${providers} providers)`);
console.log('Files: ai_price_index.csv, ai_price_index.json, description.md, dataset-metadata.json');
console.log('Web UI: kaggle.com/datasets -> New Dataset -> upload the two data files, paste description.md, license CC BY 4.0.');
console.log('CLI (optional): set the id in dataset-metadata.json, then `kaggle datasets create -p dist/kaggle`.');
