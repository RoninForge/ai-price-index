#!/usr/bin/env node
// tools/validate.mjs  (MIT)
// Zero-dependency validator for AI Price Index records + published series.
// Enforces, per CONTRIBUTING + the schema: required fields, enums, ISO dates, NO future dates,
// price bounds, valid-time interval sanity, and the provenance rule (every record carries a
// first-party source_url + a last_validated_at). A contribution without a dated first-party
// source fails here, by policy. Errors exit 1; warnings print but pass.
//
// Usage:  node tools/validate.mjs            (scans examples/ and data/)
//         AIPI_TODAY=2026-06-14 node tools/validate.mjs   (deterministic "today" for CI)

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const TODAY = process.env.AIPI_TODAY || new Date().toISOString().slice(0, 10);

const VARIATIONS = new Set([
	'input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h',
	'batch_input', 'batch_output', 'tier2_input', 'tier2_output',
	'embeddings', 'audio_per_min', 'image_per_item'
]);
const UNITS = new Set([
	'usd_per_mtok', 'usd_per_ktok', 'usd_per_image', 'usd_per_min',
	'usd_per_character', 'usd_per_request'
]);
const SOURCE_KINDS = new Set(['provider_live', 'wayback', 'changelog', 'aggregator', 'manual']);
const CONFIDENCE = new Set(['verified', 'archived', 'inferred', 'estimated']);
const PROVIDER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warnings = [];
const err = (file, where, msg) => errors.push(`${file} ${where}: ${msg}`);
const warn = (file, where, msg) => warnings.push(`${file} ${where}: ${msg}`);

const isDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));

function listJson(dir) {
	if (!existsSync(dir)) return [];
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...listJson(p));
		else if (name.endsWith('.json')) out.push(p);
	}
	return out;
}

function parse(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch (e) {
		err(file, '(parse)', `invalid JSON: ${e.message}`);
		return undefined;
	}
}

function validateRecord(file, i, r) {
	const at = `record[${i}]`;
	if (typeof r !== 'object' || r === null) return err(file, at, 'not an object');

	if (!PROVIDER_RE.test(r.provider || '')) err(file, at, `bad provider "${r.provider}"`);
	if (typeof r.model_id !== 'string' || !r.model_id) err(file, at, 'model_id required');
	if (!VARIATIONS.has(r.variation)) err(file, at, `unknown variation "${r.variation}"`);
	if (!UNITS.has(r.unit)) err(file, at, `unknown unit "${r.unit}"`);

	if (typeof r.price_usd !== 'number' || Number.isNaN(r.price_usd)) err(file, at, 'price_usd must be a number');
	else if (r.price_usd < 0 || r.price_usd > 100000) err(file, at, `price_usd ${r.price_usd} out of bounds [0, 100000]`);

	if (!isDate(r.effective_from)) err(file, at, `effective_from not an ISO date: "${r.effective_from}"`);
	else if (r.effective_from > TODAY) err(file, at, `effective_from ${r.effective_from} is in the future (today ${TODAY})`);

	if (r.effective_to !== undefined && r.effective_to !== null) {
		if (!isDate(r.effective_to)) err(file, at, `effective_to not an ISO date: "${r.effective_to}"`);
		else if (isDate(r.effective_from) && r.effective_to < r.effective_from)
			err(file, at, `effective_to ${r.effective_to} precedes effective_from ${r.effective_from}`);
	}

	// the provenance rule
	if (!isDate(r.last_validated_at)) err(file, at, 'last_validated_at required (ISO date) - the provenance rule');
	else if (r.last_validated_at > TODAY) err(file, at, `last_validated_at ${r.last_validated_at} is in the future (today ${TODAY})`);
	if (typeof r.source_url !== 'string' || !/^https?:\/\//.test(r.source_url))
		err(file, at, 'source_url required (first-party http(s) URL) - the provenance rule');

	if (!SOURCE_KINDS.has(r.source_kind)) err(file, at, `unknown source_kind "${r.source_kind}"`);
	if (!CONFIDENCE.has(r.confidence)) err(file, at, `unknown confidence "${r.confidence}"`);

	// coherence between confidence and source
	if (r.confidence === 'verified' && !['provider_live', 'manual'].includes(r.source_kind))
		err(file, at, `confidence "verified" requires source_kind provider_live or manual, got "${r.source_kind}"`);
	if (r.confidence === 'archived' && !r.source_snapshot_ts)
		warn(file, at, 'confidence "archived" without source_snapshot_ts (Wayback capture stamp)');

	if (r.source_snapshot_ts !== undefined && !/^\d{8,14}$/.test(r.source_snapshot_ts))
		err(file, at, `source_snapshot_ts must be 8-14 digits, got "${r.source_snapshot_ts}"`);

	const allowed = new Set([
		'provider', 'model_id', 'variation', 'unit', 'price_usd', 'effective_from', 'effective_to',
		'last_validated_at', 'source_url', 'source_kind', 'source_snapshot_ts', 'confidence', 'notes'
	]);
	for (const k of Object.keys(r)) if (!allowed.has(k)) err(file, at, `unknown field "${k}"`);
}

function validateSeries(file, s) {
	if (typeof s !== 'object' || s === null) return err(file, '(root)', 'not an object');
	if (typeof s.model !== 'string' || !s.model) err(file, '(root)', 'model required');
	if (!PROVIDER_RE.test(s.provider || '')) err(file, '(root)', `bad provider "${s.provider}"`);
	if (typeof s.variations !== 'object' || s.variations === null || !Object.keys(s.variations).length)
		return err(file, '(root)', 'variations object required with at least one variation');
	for (const [v, arr] of Object.entries(s.variations)) {
		if (!Array.isArray(arr) || !arr.length) { err(file, `variations.${v}`, 'must be a non-empty array'); continue; }
		arr.forEach((iv, j) => {
			const at = `variations.${v}[${j}]`;
			if (!isDate(iv.from)) err(file, at, `from not an ISO date: "${iv.from}"`);
			if (iv.to !== null && !isDate(iv.to)) err(file, at, `to must be null or an ISO date: "${iv.to}"`);
			if (typeof iv.price_usd !== 'number' || iv.price_usd < 0) err(file, at, 'price_usd must be a number >= 0');
			if (typeof iv.unit !== 'string' || !iv.unit) err(file, at, 'unit required');
			if (!isDate(iv.last_validated)) err(file, at, 'last_validated required (ISO date)');
			if (!CONFIDENCE.has(iv.confidence)) err(file, at, `unknown confidence "${iv.confidence}"`);
			if (typeof iv.src !== 'string' || !/^https?:\/\//.test(iv.src)) err(file, at, 'src required (http(s) URL)');
		});
	}
}

let recordCount = 0;
let seriesCount = 0;

for (const dir of ['examples/records', 'data/records']) {
	for (const file of listJson(dir)) {
		const data = parse(file);
		if (data === undefined) continue;
		if (!Array.isArray(data)) { err(file, '(root)', 'a records file must be a JSON array'); continue; }
		data.forEach((r, i) => { recordCount++; validateRecord(file, i, r); });
	}
}

for (const dir of ['examples/series', 'data/series', 'data/ai-price-index/models']) {
	for (const file of listJson(dir)) {
		const data = parse(file);
		if (data === undefined) continue;
		seriesCount++;
		validateSeries(file, data);
	}
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);

console.log(
	`\nai-price-index validate: ${recordCount} records, ${seriesCount} series checked ` +
		`(today=${TODAY}). ${errors.length} error(s), ${warnings.length} warning(s).`
);

process.exit(errors.length ? 1 : 0);
