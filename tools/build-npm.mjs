#!/usr/bin/env node
// Builds the inline data bundle shipped inside the npm package `ai-price-index`.
// Output: lib/data.json (gitignored, regenerable) - a single self-contained bundle the
// lookup lib reads with NO runtime network, matching the shape Goei's pricing engine vendors:
//   { schemaVersion, dataModified, license, doi, attribution, source, sources[], series[], current[] }
// Source of truth: the already-published, committed static artifacts under data/ai-price-index/
// (current.json + the per-model series in models/**). Reading those - rather than re-deriving from
// data/records/** - guarantees the bundle is byte-for-byte the dataset the site and Goei serve.
// Run: node tools/build-npm.mjs   (also wired as the package `prepack` step, so `npm publish` is turnkey)
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'ai-price-index');
const OUT = join(ROOT, 'lib', 'data.json');
const REPO = 'https://github.com/RoninForge/ai-price-index';
const DATA_PAGE = 'https://roninforge.org/data/ai-price-index/';
// Concept DOI: always resolves to the latest version. Per-release version DOIs differ.
const DOI = '10.5281/zenodo.20730240';

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function walkJson(dir) {
	const out = [];
	if (!existsSync(dir)) return out;
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walkJson(p));
		else if (name.endsWith('.json')) out.push(p);
	}
	return out;
}

// Best-effort git provenance. In CI the package is built from a checkout pinned at the dataset
// release tag, so HEAD is exactly the published data; locally it is the working commit.
function git(args, fallback = '') {
	try {
		return execFileSync('git', ['-C', ROOT, ...args], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'ignore']
		}).trim();
	} catch {
		return fallback;
	}
}

if (!existsSync(join(DATA, 'current.json')) || !existsSync(join(DATA, 'index.json'))) {
	console.error(`build-npm: missing published artifacts under ${DATA}. Nothing to bundle.`);
	process.exit(1);
}

const current = readJson(join(DATA, 'current.json'));
const series = walkJson(join(DATA, 'models'))
	.map(readJson)
	.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));

// Every distinct first-party source URL, so a consumer can audit provenance without the per-row scan.
const sourceSet = new Set();
for (const p of current.prices) sourceSet.add(p.src);
for (const m of series) for (const ivs of Object.values(m.variations)) for (const iv of ivs) sourceSet.add(iv.src);

const sha = git(['rev-parse', 'HEAD'], 'unknown');
const ref = git(['describe', '--tags', '--exact-match'], '') || git(['describe', '--tags'], '') || sha;

const bundle = {
	schemaVersion: current.schemaVersion ?? '1.0.0',
	dataModified: current.dataModified,
	license: current.license,
	doi: DOI,
	attribution: `AI Price Index by RoninForge (${DATA_PAGE}), CC BY 4.0`,
	source: { repo: REPO, ref, sha, dataPage: DATA_PAGE },
	sources: [...sourceSet].filter(Boolean).sort(),
	series,
	current: current.prices
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(bundle) + '\n');

const providers = new Set(series.map((s) => s.provider));
console.log(
	`build-npm: ${series.length} models, ${providers.size} providers, ${current.prices.length} current rows, dataModified=${bundle.dataModified}, ref=${ref} -> lib/data.json`
);
