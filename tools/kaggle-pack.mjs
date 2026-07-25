#!/usr/bin/env node
// Packs the Kaggle upload bundle into dist/kaggle/ from the Hugging Face export.
// The CSV/JSON are identical to the HF mirror (one flat table), so this reuses dist/hf/*.
// Run: node tools/hf-export.mjs && node tools/kaggle-pack.mjs
//
// Output (dist/kaggle/, gitignored):
//   ai_price_index.csv      the data (drag into the Kaggle web UI, or `kaggle datasets create -p`)
//   ai_price_index.json     the same records as JSON
//   description.md          rendered description (paste into the web form's description field)
//   file-descriptions.md    rendered per-file "About this file" blurbs (web-UI path only; the CLI
//                           applies these automatically from dataset-metadata.json resources[])
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

// Column count read off the CSV header rather than hardcoded, so it cannot drift from the export.
// Header names are plain identifiers (no quoted commas), so a naive split is safe here.
const csvText = readFileSync(csv, 'utf8');
const columns = csvText.slice(0, csvText.indexOf('\n')).trim().split(',').length;

// Kaggle's per-file "About this file" blurbs. These live in `resources[].description` and are a
// SEPARATE field from the dataset description, so editing the description in the web UI does not
// touch them. They carry record counts, so they go stale on every refresh unless rendered here.
const fileDescriptions = {
	'ai_price_index.csv':
		`The full dataset as a flat table: one row per model and price variation (input or output) for ` +
		`each dated validity window. ${records} rows, ${columns} columns. Load directly with pandas ` +
		`(pd.read_csv) or Hugging Face datasets (load_dataset). To get current prices, filter rows ` +
		`where effective_to is empty.`,
	'ai_price_index.json':
		`The same ${records} price records as a JSON array of objects, with identical fields to the ` +
		`CSV. Convenient for non-tabular tooling.`
};

copyFileSync(csv, join(outDir, 'ai_price_index.csv'));
copyFileSync(json, join(outDir, 'ai_price_index.json'));
writeFileSync(join(outDir, 'description.md'), description);

// Pasteable copy for the web-UI path: `kaggle datasets version` applies resources[] automatically,
// but a New Version uploaded through the browser does not, and the blurbs must be pasted by hand.
writeFileSync(
	join(outDir, 'file-descriptions.md'),
	`# Kaggle per-file descriptions\n\n` +
		`Paste each into "About this file" (Data Card -> pick the file in Data Explorer -> pencil).\n` +
		`Only needed for the web-UI path; \`kaggle datasets version -p dist/kaggle\` applies these\n` +
		`automatically from dataset-metadata.json.\n\n` +
		Object.entries(fileDescriptions)
			.map(([path, text]) => `## ${path}\n\n${text}\n`)
			.join('\n')
);

// Kaggle CLI metadata. `id` is <kaggle-username>/<slug>; the live dataset is roninforge/ai-price-index,
// so `kaggle datasets version -p dist/kaggle` targets the existing dataset with no manual edit.
const metadata = {
	title: 'AI Price Index',
	id: 'roninforge/ai-price-index',
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
	resources: Object.entries(fileDescriptions).map(([path, description]) => ({ path, description }))
};
writeFileSync(join(outDir, 'dataset-metadata.json'), JSON.stringify(metadata, null, 2) + '\n');

console.log(
	`Packed dist/kaggle/  (${records} records, ${models} models, ${providers} providers, ${columns} columns)`
);
console.log(
	'Files: ai_price_index.csv, ai_price_index.json, description.md, file-descriptions.md, dataset-metadata.json'
);
console.log('Web UI: kaggle.com/datasets/roninforge/ai-price-index -> New Version -> drag the two data files.');
console.log('        then paste description.md AND file-descriptions.md (the per-file blurbs are a separate field).');
console.log('CLI (optional): `kaggle datasets version -p dist/kaggle -m "<tag>"` (id already set to roninforge/ai-price-index).');
