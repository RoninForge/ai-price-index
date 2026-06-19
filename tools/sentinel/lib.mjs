// tools/sentinel/lib.mjs  (MIT)
// Shared, dependency-free helpers for the AI Price Index price-sentinel.
//
// Zero npm deps. Node >=18 (uses the built-in global fetch + AbortController/AbortSignal.timeout).
// Everything here is pure / IO-thin and reused by tripwire.mjs, the collectors, and run.mjs.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo root = two levels up from tools/sentinel/
export const REPO_ROOT = join(__dirname, '..', '..');

const USER_AGENT = 'ai-price-index price-sentinel (+https://roninforge.org)';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today as an ISO date (YYYY-MM-DD). Honors AIPI_TODAY for deterministic CI, matching validate.mjs. */
export function today() {
	return process.env.AIPI_TODAY || new Date().toISOString().slice(0, 10);
}

export function isIsoDate(s) {
	return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s));
}

// ---------------------------------------------------------------------------
// fetch with timeout + retries
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, { retries = DEFAULT_RETRIES, timeoutMs = DEFAULT_TIMEOUT_MS, accept } = {}) {
	let lastErr;
	for (let attempt = 0; attempt <= retries; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const headers = { 'user-agent': USER_AGENT };
			if (accept) headers['accept'] = accept;
			const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
			return res;
		} catch (e) {
			lastErr = e;
			// brief linear backoff between attempts; no jitter needed for a daily batch job
			if (attempt < retries) await sleep(400 * (attempt + 1));
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(`fetch failed after ${retries + 1} attempt(s): ${lastErr && lastErr.message}`);
}

function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Fetch a URL and return the response body as text. Throws on non-2xx or timeout. */
export async function fetchText(url, opts = {}) {
	const res = await fetchWithRetry(url, opts);
	return await res.text();
}

/** Fetch a URL and return parsed JSON. Throws on non-2xx, timeout, or invalid JSON. */
export async function fetchJson(url, opts = {}) {
	const res = await fetchWithRetry(url, { accept: 'application/json', ...opts });
	const txt = await res.text();
	try {
		return JSON.parse(txt);
	} catch (e) {
		throw new Error(`invalid JSON from ${url}: ${e.message}`);
	}
}

// ---------------------------------------------------------------------------
// price normalization
// ---------------------------------------------------------------------------

/**
 * Normalize a price into USD per million tokens (usd_per_mtok).
 * Accepts a number or a numeric string, in one of two scales:
 *   scale "per_token"  -> e.g. OpenRouter "0.000005"  -> 5
 *   scale "per_mtok"   -> already per-Mtok            -> returned as-is
 * Returns a finite number, or null if the value cannot be parsed (e.g. "" / "-1" sentinels).
 */
export function toUsdPerMtok(value, scale = 'per_token') {
	const n = typeof value === 'number' ? value : parseFloat(String(value));
	if (!Number.isFinite(n) || n < 0) return null;
	if (scale === 'per_mtok') return n;
	if (scale === 'per_token') return n * 1_000_000;
	throw new Error(`toUsdPerMtok: unknown scale "${scale}"`);
}

// ---------------------------------------------------------------------------
// current published prices + known-model set (alias-aware)
// ---------------------------------------------------------------------------

/**
 * Load the published current.json + index.json into an alias-aware view.
 * Returns:
 *   {
 *     byProviderModel: Map<"provider/model", { input?, output?, cache_read?, ... }>,  // canonical-keyed
 *     resolve(provider, idOrAlias) -> canonical model id | null,                       // alias-aware
 *     known: Set<string>,            // every canonical id + alias seen, bare (no provider prefix)
 *     knownByProvider: Map<provider, Set<string>>,  // ids + aliases scoped per provider
 *     providers: Set<string>,        // provider slugs we publish
 *   }
 */
export function loadCurrent(root = REPO_ROOT) {
	const currentPath = join(root, 'data', 'ai-price-index', 'current.json');
	const indexPath = join(root, 'data', 'ai-price-index', 'index.json');
	const current = JSON.parse(readFileSync(currentPath, 'utf8'));
	const index = JSON.parse(readFileSync(indexPath, 'utf8'));

	const byProviderModel = new Map();
	for (const p of current.prices || []) {
		const key = `${p.provider}/${p.model}`;
		const bucket = byProviderModel.get(key) || {};
		bucket[p.variation] = p.price_usd;
		byProviderModel.set(key, bucket);
	}

	// alias -> canonical, per provider; plus the flat + per-provider known sets
	const aliasToCanonical = new Map(); // key "provider/alias" -> canonical id
	const known = new Set();
	const knownByProvider = new Map();
	const providers = new Set();

	const addKnown = (provider, id) => {
		providers.add(provider);
		known.add(id);
		if (!knownByProvider.has(provider)) knownByProvider.set(provider, new Set());
		knownByProvider.get(provider).add(id);
	};

	for (const m of index.models || []) {
		addKnown(m.provider, m.id);
		aliasToCanonical.set(`${m.provider}/${m.id}`, m.id);
		for (const a of m.aliases || []) {
			addKnown(m.provider, a);
			aliasToCanonical.set(`${m.provider}/${a}`, m.id);
		}
	}
	// current.json may carry models not (yet) in index.json; treat their ids as known too
	for (const p of current.prices || []) {
		addKnown(p.provider, p.model);
		if (!aliasToCanonical.has(`${p.provider}/${p.model}`))
			aliasToCanonical.set(`${p.provider}/${p.model}`, p.model);
	}

	const resolve = (provider, idOrAlias) => aliasToCanonical.get(`${provider}/${idOrAlias}`) || null;

	return { byProviderModel, resolve, known, knownByProvider, providers };
}

// ---------------------------------------------------------------------------
// classify (NEW / CHANGED / UNCHANGED)
// ---------------------------------------------------------------------------

/**
 * Classify an extracted model against the published current prices.
 *   provider  : our provider slug
 *   model     : a model id or alias as seen at the source
 *   extracted : { input?, output?, cache_read?, ... } numbers in usd_per_mtok
 *   current   : the object returned by loadCurrent()
 * Returns "NEW" | "CHANGED" | "UNCHANGED".
 * A model unknown to current/index is NEW. A known model whose any overlapping
 * variation differs (beyond float epsilon) is CHANGED, else UNCHANGED.
 */
export function classify(provider, model, extracted, current) {
	const canonical = current.resolve(provider, model);
	if (!canonical) return 'NEW';
	const have = current.byProviderModel.get(`${provider}/${canonical}`);
	if (!have) return 'NEW'; // in index but no published price row yet
	for (const [variation, price] of Object.entries(extracted)) {
		if (typeof price !== 'number') continue;
		if (!(variation in have)) continue; // only compare overlapping variations
		if (!nearlyEqual(have[variation], price)) return 'CHANGED';
	}
	return 'UNCHANGED';
}

function nearlyEqual(a, b, eps = 1e-9) {
	return Math.abs(a - b) <= eps + 1e-6 * Math.max(Math.abs(a), Math.abs(b));
}

// ---------------------------------------------------------------------------
// makeRecord (contribution-form record builder; throws on anything invalid)
// ---------------------------------------------------------------------------

const VARIATIONS = new Set([
	'input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h',
	'batch_input', 'batch_output', 'tier2_input', 'tier2_output',
	'embeddings', 'audio_per_min', 'image_per_item',
]);
const UNITS = new Set([
	'usd_per_mtok', 'usd_per_ktok', 'usd_per_image', 'usd_per_min',
	'usd_per_character', 'usd_per_request',
]);
const SOURCE_KINDS = new Set(['provider_live', 'wayback', 'changelog', 'aggregator', 'manual']);
const CONFIDENCE = new Set(['verified', 'archived', 'inferred', 'estimated']);
const PROVIDER_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Build a contribution-form price record. THROWS (fail loud) if any required field is missing,
 * an enum is invalid, a date is malformed or in the future, or the price is out of bounds.
 * The output mirrors exactly what tools/validate.mjs accepts; nothing here invents bitemporal fields.
 */
export function makeRecord(fields) {
	const f = { ...fields };
	const t = today();
	const fail = (msg) => {
		throw new Error(`makeRecord(${f.provider}/${f.model_id}/${f.variation}): ${msg}`);
	};

	if (!PROVIDER_RE.test(f.provider || '')) fail(`bad provider "${f.provider}"`);
	if (typeof f.model_id !== 'string' || !f.model_id) fail('model_id required');
	if (!VARIATIONS.has(f.variation)) fail(`unknown variation "${f.variation}"`);
	if (!UNITS.has(f.unit)) fail(`unknown unit "${f.unit}"`);

	if (typeof f.price_usd !== 'number' || Number.isNaN(f.price_usd)) fail('price_usd must be a number');
	if (f.price_usd < 0 || f.price_usd > 100000) fail(`price_usd ${f.price_usd} out of bounds [0, 100000]`);

	if (!isIsoDate(f.effective_from)) fail(`effective_from not an ISO date: "${f.effective_from}"`);
	if (f.effective_from > t) fail(`effective_from ${f.effective_from} is in the future (today ${t})`);

	// effective_to defaults to null (still current) when omitted
	if (f.effective_to === undefined) f.effective_to = null;
	if (f.effective_to !== null) {
		if (!isIsoDate(f.effective_to)) fail(`effective_to not an ISO date: "${f.effective_to}"`);
		if (f.effective_to < f.effective_from) fail(`effective_to ${f.effective_to} precedes effective_from`);
	}

	// last_validated_at defaults to today
	if (f.last_validated_at === undefined) f.last_validated_at = t;
	if (!isIsoDate(f.last_validated_at)) fail(`last_validated_at not an ISO date: "${f.last_validated_at}"`);
	if (f.last_validated_at > t) fail(`last_validated_at ${f.last_validated_at} is in the future (today ${t})`);

	if (typeof f.source_url !== 'string' || !/^https:\/\//.test(f.source_url))
		fail(`source_url required (https URL), got "${f.source_url}"`);
	if (!SOURCE_KINDS.has(f.source_kind)) fail(`unknown source_kind "${f.source_kind}"`);
	if (!CONFIDENCE.has(f.confidence)) fail(`unknown confidence "${f.confidence}"`);
	if (f.confidence === 'verified' && !['provider_live', 'manual'].includes(f.source_kind))
		fail(`confidence "verified" requires source_kind provider_live or manual, got "${f.source_kind}"`);

	if (f.aliases !== undefined) {
		if (!Array.isArray(f.aliases) || f.aliases.some((a) => typeof a !== 'string' || !a))
			fail('aliases must be an array of non-empty strings');
		if (new Set(f.aliases).size !== f.aliases.length) fail('duplicate alias');
	}
	if (f.notes !== undefined && typeof f.notes !== 'string') fail('notes must be a string');

	// emit only the allowed contribution-form keys, in a stable order
	const out = {
		provider: f.provider,
		model_id: f.model_id,
		variation: f.variation,
		unit: f.unit,
		price_usd: f.price_usd,
		effective_from: f.effective_from,
		effective_to: f.effective_to,
		last_validated_at: f.last_validated_at,
		source_url: f.source_url,
		source_kind: f.source_kind,
		confidence: f.confidence,
	};
	if (f.aliases !== undefined) out.aliases = f.aliases;
	if (f.notes !== undefined) out.notes = f.notes;
	return out;
}
