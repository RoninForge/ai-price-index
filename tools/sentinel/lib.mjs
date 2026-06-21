// tools/sentinel/lib.mjs  (MIT)
// Shared, dependency-free helpers for the AI Price Index price-sentinel.
//
// Zero npm deps. Node >=18 (uses the built-in global fetch + AbortController/AbortSignal.timeout).
// Everything here is pure / IO-thin and reused by tripwire.mjs, the collectors, and run.mjs.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
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

/**
 * Resolve effective_from for a freshly-discovered NEW model.
 *   * If `createdDate` is a valid ISO date (e.g. converted from the tripwire's OpenRouter `created`
 *     unix timestamp), use it as the model's launch date - it is the closest real signal we have.
 *   * A future created-date is CLAMPED to today (makeRecord would otherwise reject it, and we never
 *     publish a future effective_from for an already-live price).
 *   * If `createdDate` is absent or malformed, fall back to today(): we do not invent a precise launch
 *     date for a model we just saw; a human/backfill can correct it with a dated snapshot.
 * Returns a YYYY-MM-DD string, never in the future.
 */
export function effectiveFromForNew(createdDate, todayStr = today()) {
	if (isIsoDate(createdDate)) {
		return createdDate > todayStr ? todayStr : createdDate;
	}
	return todayStr;
}

/** Convert a unix timestamp in SECONDS to a YYYY-MM-DD ISO date, or null if not finite. */
export function unixSecToIsoDate(sec) {
	if (typeof sec !== 'number' || !Number.isFinite(sec)) return null;
	return new Date(sec * 1000).toISOString().slice(0, 10);
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
 * Read every data/records/<provider>.json and return the CURRENT provenance per
 * provider+model+variation - i.e. the still-open interval (effective_to === null) that backs the
 * published price. The records files (contribution form) are the only place that carries BOTH
 * `confidence` and `source_kind`; current.json carries confidence but not source_kind. We key by the
 * record's own model_id (the canonical id), variation -> { confidence, source_kind }. If a model has
 * more than one open interval for a variation (it should not), the LAST one read wins (matches how the
 * latest appended record would shadow an earlier one in a simple consumer).
 * Returns Map<"provider/model_id", { [variation]: { confidence, source_kind } }>.
 */
function loadRecordsProvenance(root = REPO_ROOT) {
	const dir = join(root, 'data', 'records');
	const byProviderModel = new Map();
	if (!existsSync(dir)) return byProviderModel;
	for (const file of readdirSync(dir)) {
		if (!file.endsWith('.json')) continue;
		let recs;
		try {
			recs = JSON.parse(readFileSync(join(dir, file), 'utf8'));
		} catch {
			continue; // a malformed records file must not crash loadCurrent
		}
		if (!Array.isArray(recs)) continue;
		for (const r of recs) {
			if (!r || r.effective_to !== null) continue; // only the open (current) interval
			if (typeof r.provider !== 'string' || typeof r.model_id !== 'string' || typeof r.variation !== 'string') continue;
			const key = `${r.provider}/${r.model_id}`;
			const bucket = byProviderModel.get(key) || {};
			bucket[r.variation] = { confidence: r.confidence, source_kind: r.source_kind };
			byProviderModel.set(key, bucket);
		}
	}
	return byProviderModel;
}

/**
 * Load the published current.json + index.json into an alias-aware view.
 * Returns:
 *   {
 *     byProviderModel: Map<"provider/model", { input?, output?, cache_read?, ... }>,  // canonical-keyed prices
 *     provenanceByProviderModel: Map<"provider/model", { [variation]: { confidence, source_kind } }>,
 *     provenanceFor(provider, idOrAlias) -> { [variation]: { confidence, source_kind } } | null,  // alias-aware
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

	// current/published provenance (confidence + source_kind) from the records files (canonical-keyed)
	const provenanceByProviderModel = loadRecordsProvenance(root);

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

	// Alias-aware lookup of the current provenance for a provider+model (or alias).
	const provenanceFor = (provider, idOrAlias) => {
		const canonical = resolve(provider, idOrAlias);
		if (!canonical) return null;
		return provenanceByProviderModel.get(`${provider}/${canonical}`) || null;
	};

	return {
		byProviderModel,
		provenanceByProviderModel,
		provenanceFor,
		resolve,
		known,
		knownByProvider,
		providers,
	};
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
// provenance + UPGRADE detection (provisional -> verified lifecycle)
// ---------------------------------------------------------------------------

// "Weak" provenance: the record exists but is not first-party-verified. A model whose CURRENT record
// has any of these confidences, OR any of these source_kinds, is a candidate for a provenance upgrade
// when a first-party collector later confirms the SAME price.
const WEAK_CONFIDENCE = new Set(['inferred', 'estimated']);
const WEAK_SOURCE_KIND = new Set(['aggregator', 'changelog', 'manual']);

/**
 * Is `current` ({ confidence, source_kind }) weaker provenance than `incoming`?
 * Weaker means: current.confidence in {inferred, estimated} OR current.source_kind in
 * {aggregator, changelog, manual}, while incoming is a genuine first-party upgrade
 * (confidence verified + source_kind provider_live). Returns false if either side is missing the
 * fields, or if current is already verified+provider_live (nothing to upgrade).
 */
export function isWeakerProvenance(current, incoming) {
	if (!current || !incoming) return false;
	const incStrong = incoming.confidence === 'verified' && incoming.source_kind === 'provider_live';
	if (!incStrong) return false;
	const curWeak = WEAK_CONFIDENCE.has(current.confidence) || WEAK_SOURCE_KIND.has(current.source_kind);
	return curWeak;
}

/**
 * Classify a first-party-collected model against the published prices + provenance for the
 * provisional->verified lifecycle. Returns one of:
 *   'NEW'       - unknown model (delegates to classify()).
 *   'CHANGED'   - known model whose price differs (delegates to classify()).
 *   'UPGRADE'   - known model at the SAME price (within epsilon, per overlapping variation) whose
 *                 CURRENT record is WEAKER provenance than what the collector now supplies
 *                 (verified + provider_live). Only fires when at least one overlapping, same-price
 *                 variation is currently weak.
 *   'UNCHANGED' - known, same price, and provenance is already at least as strong.
 *
 *   provider  : our provider slug
 *   model     : a model id or alias as seen at the source
 *   extracted : { input?, output?, ... } numbers in usd_per_mtok (the collector's prices)
 *   incoming  : { confidence, source_kind } the collector's provenance for this model
 *   current   : the object returned by loadCurrent()
 */
export function classifyUpgrade(provider, model, extracted, incoming, current) {
	const base = classify(provider, model, extracted, current);
	if (base !== 'UNCHANGED') return base; // NEW / CHANGED keep their existing semantics
	// Same price. Is our current record weaker provenance than what the collector now confirms?
	const canonical = current.resolve(provider, model);
	if (!canonical) return 'UNCHANGED';
	const have = current.byProviderModel.get(`${provider}/${canonical}`);
	const prov = current.provenanceByProviderModel.get(`${provider}/${canonical}`);
	if (!have || !prov) return 'UNCHANGED';
	for (const [variation, price] of Object.entries(extracted)) {
		if (typeof price !== 'number') continue;
		if (!(variation in have)) continue; // only the variations we actually publish
		if (!nearlyEqual(have[variation], price)) continue; // CHANGED would have caught this; be safe
		if (isWeakerProvenance(prov[variation], incoming)) return 'UPGRADE';
	}
	return 'UNCHANGED';
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
