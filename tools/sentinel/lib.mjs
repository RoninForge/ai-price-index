// tools/sentinel/lib.mjs  (MIT)
// Shared, dependency-free helpers for the AI Price Index price-sentinel.
//
// Zero npm deps. Node >=18 (uses the built-in global fetch + AbortController/AbortSignal.timeout).
// Everything here is pure / IO-thin and reused by tripwire.mjs, the collectors, and run.mjs.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { normalizeModelKey } from './crosscheck.mjs';

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

/**
 * The source could not be reached: DNS, timeout, or a non-2xx status. Distinct from a collector
 * throwing because it could not understand a page it DID receive - the first is transient, the
 * second means we are no longer monitoring that provider.
 */
export class SourceUnavailableError extends Error {
	constructor(message) {
		super(message);
		this.name = 'SourceUnavailableError';
		this.code = 'SOURCE_UNAVAILABLE';
	}
}

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
	throw new SourceUnavailableError(`fetch failed after ${retries + 1} attempt(s): ${lastErr && lastErr.message}`);
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
 * Scan every data/records/<provider>.json and decide, per provider+model_id, whether the model is
 * ARCHIVED in our records - i.e. we have deliberately retired it. A model is archived when it has
 * records but NO open/active interval: NO record has effective_to === null.
 * Closing the interval is the ONLY evidence of retirement. Provenance grades ("archived" confidence,
 * "wayback" source_kind) describe where a NUMBER came from, never whether the MODEL is alive, and are
 * deliberately not consulted here.
 * This is keyed off our RECORDS' archived state (not current.json), so it stays correct even when
 * current.json is stale or out of sync. The result is canonical-model-keyed; loadCurrent() wraps it
 * with an alias-aware lookup. Returns
 *   { archived: Set<"provider/model_id">, aliasToCanonical: Map<"provider/alias" -> model_id> }
 * where aliasToCanonical is built from the records files themselves (so alias resolution works even
 * for a retired model that is no longer surfaced in index.json/current.json).
 */
function loadArchivedModels(root = REPO_ROOT) {
	const dir = join(root, 'data', 'records');
	const archived = new Set();
	const aliasToCanonical = new Map(); // "provider/alias" -> canonical model_id (records-derived)
	if (!existsSync(dir)) return { archived, aliasToCanonical };
	// group every record by provider/model_id so we can reason about the whole model's intervals
	const byModel = new Map(); // "provider/model_id" -> { hasOpen, latest: {from, confidence, source_kind} }
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
			if (!r || typeof r.provider !== 'string' || typeof r.model_id !== 'string') continue;
			const key = `${r.provider}/${r.model_id}`;
			const agg = byModel.get(key) || { hasOpen: false, latest: null };
			if (r.effective_to === null || r.effective_to === undefined) agg.hasOpen = true;
			const from = typeof r.effective_from === 'string' ? r.effective_from : '';
			if (!agg.latest || from > agg.latest.from) {
				agg.latest = { from, confidence: r.confidence, source_kind: r.source_kind };
			}
			byModel.set(key, agg);
			// the model id always resolves to itself; aliases resolve to the canonical model_id
			aliasToCanonical.set(`${r.provider}/${r.model_id}`, r.model_id);
			if (Array.isArray(r.aliases)) {
				for (const a of r.aliases) {
					if (typeof a === 'string' && a) aliasToCanonical.set(`${r.provider}/${a}`, r.model_id);
				}
			}
		}
	}
	for (const [key, agg] of byModel) {
		// ARCHIVED is a LIFECYCLE state and the only evidence for it is that we closed every interval.
		// It is deliberately NOT inferred from `confidence: 'archived'` / `source_kind: 'wayback'`,
		// which are PROVENANCE grades meaning "this number came off an archive snapshot": a live model
		// whose newest row was backfilled from Wayback is still live, and reading it as retired
		// silently suppressed the missing-variation pass and the NEW path for it.
		if (!agg.hasOpen) archived.add(key);
	}
	return { archived, aliasToCanonical };
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

	// models we have deliberately archived in data/records, computed from the RECORDS' archived state
	// (not current.json), plus a records-derived alias->canonical map for archived models that may no
	// longer appear in index.json/current.json.
	const { archived: archivedByProviderModel, aliasToCanonical: recordsAliasToCanonical } = loadArchivedModels(root);
	// normalized-key view of the archived set so a date-stripped tripwire id ("claude-3-5-haiku" from
	// "anthropic/claude-3.5-haiku") still matches its dated canonical record ("claude-3-5-haiku-20241022").
	const archivedNormKeys = new Set();
	for (const k of archivedByProviderModel) {
		const slash = k.indexOf('/');
		const prov = k.slice(0, slash);
		const id = k.slice(slash + 1);
		archivedNormKeys.add(`${prov}/${normalizeModelKey(id)}`);
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

	// Alias-aware lookup of the current provenance for a provider+model (or alias).
	const provenanceFor = (provider, idOrAlias) => {
		const canonical = resolve(provider, idOrAlias);
		if (!canonical) return null;
		return provenanceByProviderModel.get(`${provider}/${canonical}`) || null;
	};

	// Alias-aware: is this provider+model (or alias) ARCHIVED in our data/records? Resolves the id
	// through (a) the index/current alias map, (b) the records-derived alias map (covers retired models
	// no longer in index.json), then checks the records-derived archived Set. Falls back to a direct
	// lookup of the raw id so a candidate's bare id matches even without a resolver hit.
	const isArchived = (provider, idOrAlias) => {
		const canonical =
			resolve(provider, idOrAlias) || recordsAliasToCanonical.get(`${provider}/${idOrAlias}`) || idOrAlias;
		if (archivedByProviderModel.has(`${provider}/${canonical}`)) return true;
		// last resort: normalized-key match (handles date-stripped tripwire ids vs dated canonical records)
		const nk = normalizeModelKey(idOrAlias);
		return nk ? archivedNormKeys.has(`${provider}/${nk}`) : false;
	};

	return {
		byProviderModel,
		provenanceByProviderModel,
		archivedByProviderModel,
		provenanceFor,
		resolve,
		isArchived,
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
const WEAK_CONFIDENCE = new Set(['inferred', 'estimated', 'archived']);
const WEAK_SOURCE_KIND = new Set(['aggregator', 'changelog', 'manual', 'wayback']);

/**
 * Is `current` ({ confidence, source_kind }) weaker provenance than `incoming`?
 * Weaker means: current.confidence in {inferred, estimated, archived} OR current.source_kind in
 * {aggregator, changelog, manual, wayback}, while incoming is a genuine first-party upgrade
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

/**
 * Variations the collector read off the provider's own page for a model we ALREADY track, but which
 * we do not publish a price row for.
 *
 * This is the gap `classify()` cannot see. classify() answers "did a price we already record move?"
 * and deliberately skips any variation absent from our data (`if (!(variation in have)) continue`),
 * so a model tracked on input+output alone stays UNCHANGED forever while its cache and long-context
 * rates are fetched twice a day and thrown away. Found 2026-07-30 with 56 such rows standing across
 * anthropic/xai/openai/google/deepseek; the same shape as the xAI cache_read gap fixed 2026-07-27.
 *
 * Returns `{ canonical, missing: { variation: price } }`, or null when there is nothing to add.
 * NEW models return null on purpose: they have no published row yet, so the NEW path already drafts
 * every variation the collector saw and would otherwise double-draft here.
 */
export function missingVariations(provider, model, extracted, current) {
	const canonical = current.resolve(provider, model);
	if (!canonical) return null; // NEW model -> the NEW path drafts all of its variations
	const have = current.byProviderModel.get(`${provider}/${canonical}`);
	if (!have) return null; // in the index but unpriced -> classify() calls it NEW, same reasoning

	const missing = {};
	for (const [variation, price] of Object.entries(extracted)) {
		if (typeof price !== 'number') continue;
		if (variation in have) continue; // we publish it: CHANGED/UNCHANGED already covers it
		missing[variation] = price;
	}
	return Object.keys(missing).length ? { canonical, missing } : null;
}

// ---------------------------------------------------------------------------
// "new family" filter for pending_first_party
// ---------------------------------------------------------------------------
//
// report.pending_first_party should surface ONLY a genuinely-new model FAMILY from a core lab that we
// do not track at all (the rare "a claude-5 / gemini-4 / gpt-6 line appeared" signal worth a human's
// attention) - NOT the long tail of open-weight size variants (qwen3-14b, qwen3-235b-a22b-2507),
// quantized builds (...-fp8, ...-NVFP4), or dated/variant snapshots of families we already track
// (gpt-5.1-codex, gpt-5.3-chat, command-r-08-2024, claude-opus-4.8-fast).
//
// The filter below is intentionally heuristic and tuned against the real live tripwire output. It runs
// on the NORMALIZED key (see normalizeModelKey), which flattens dots to hyphens, so e.g. gpt-5.1 ->
// "gpt-5-1", qwen3.5 -> "qwen3-5", deepseek-v3.2 -> "deepseek-v3-2".

// A single hyphen-separated token that denotes a model SIZE: 7b/72b/405b/17b, a MoE active-param tag
// a22b/a3b/a17b, an 8x22b mixture, an expert-count 128e/16e, or a Gemma-style e4b "effective" size.
const SIZE_TOKEN_RE = /^\d+(?:\.\d+)?b$|^a\d+b$|^\d+x\d+b$|^\d+e$|^e\d+b$|^\d+x\d+$/;
// A single token denoting a quantization / inference build of an open-weight checkpoint.
const QUANT_TOKEN_RE = /^(?:fp8|fp4|nvfp4|gptq|awq|int4|int8|bf16|w8a8)$/;

/** True if any hyphen token of the normalized key is a size/MoE/expert-count tag. */
function hasSizeTag(normKey) {
	return normKey.split('-').some((t) => SIZE_TOKEN_RE.test(t));
}
/** True if any hyphen token of the normalized key is a quantization tag. */
function hasQuantTag(normKey) {
	return normKey.split('-').some((t) => QUANT_TOKEN_RE.test(t));
}

// Trailing tokens that mark a variant/snapshot rather than a distinct family. Generic tier words
// (max/plus/pro/...) are included so a tier sibling of a tracked family does not read as a new family.
const VARIANT_TOKENS = new Set([
	'codex', 'chat', 'instruct', 'base', 'vision', 'audio', 'mini', 'nano', 'fast', 'lite',
	'reasoning', 'thinking', 'search', 'realtime', 'tts', 'image', 'embed', 'rerank', 'guard',
	'preview', 'beta', 'latest', 'distill', 'it', 'exp', 'speciale', 'terminus', 'original',
	'eagle', 'onnx', 'online',
	'max', 'plus', 'pro', 'flash', 'turbo', 'high', 'low', 'medium', 'small', 'large', 'next',
]);

/**
 * Strip trailing variant/snapshot/size/quant tokens off a normalized key so the remainder is the
 * stable family stem. Strips dated snapshots (-YYYYMMDD, the flattened -YYYY-MM-DD/-MM-DD digit
 * groups, 4-digit MMYY/version stamps like -2507/-0309/-2512), -vN, -16k context tags, size/quant
 * tags, and the variant suffixes above - repeatedly, from the right.
 */
function stripTrailingVariants(normKey) {
	const p = normKey.split('-');
	let changed = true;
	while (changed && p.length > 1) {
		changed = false;
		const last = p[p.length - 1];
		if (/^\d{8}$/.test(last)) { p.pop(); changed = true; continue; }      // -YYYYMMDD
		if (/^\d{4}$/.test(last)) { p.pop(); changed = true; continue; }      // -2507 / -0309 / -2512 stamp
		if (/^\d{2}$/.test(last)) { p.pop(); changed = true; continue; }      // -02 / -23 (flattened date group)
		if (/^v\d+$/.test(last)) { p.pop(); changed = true; continue; }       // -v1
		if (/^\d+k$/.test(last)) { p.pop(); changed = true; continue; }       // -16k context tag
		if (SIZE_TOKEN_RE.test(last) || QUANT_TOKEN_RE.test(last)) { p.pop(); changed = true; continue; }
		if (VARIANT_TOKENS.has(last)) { p.pop(); changed = true; continue; }
	}
	return p.join('-');
}

// A family root that is just a bare vendor word means stripping removed every distinguishing token -
// i.e. it is a pure variant of an existing family (e.g. gpt-audio -> "gpt"), so treat it as tracked.
const BARE_VENDOR_ROOTS = new Set([
	'gpt', 'claude', 'gemini', 'gemma', 'qwen', 'nova', 'command', 'llama', 'mistral', 'deepseek',
	'grok', 'jamba', 'janus', 'ministral', 'mixtral', 'codestral', 'devstral', 'magistral', 'voxtral',
	'leanstral',
]);

/**
 * Derive a COARSE family root from a normalized model key: vendor + line + MAJOR version, dropping
 * tier words, snapshots, and (for most labs) the minor version, so that a candidate and the tracked
 * ids of the same family collapse to the same root. Examples (normalized -> root):
 *   gpt-5-1-codex   -> gpt-5        gpt-4o          -> gpt-4
 *   claude-opus-4-8 -> claude-opus-4   gemini-3-pro -> gemini-3   gemini-2-5-pro -> gemini-2-5
 *   qwen3-14b       -> qwen3        qwen-2-5-7b     -> qwen-2-5    deepseek-v3-2  -> deepseek-v3
 *   llama-4-scout   -> llama-4      mistral-large-3 -> mistral-large   grok-5      -> grok-5
 * Used both to build the tracked-family set (from loadCurrent ids+aliases) and to classify candidates.
 */
export function familyRoot(normKey) {
	const key = stripTrailingVariants(normKey);
	const p = key.split('-');

	// OpenAI gpt-N(.m): collapse to gpt-<major>; gpt-4o -> gpt-4.
	if (p[0] === 'gpt') {
		if (/^\d+$/.test(p[1] || '')) return `gpt-${p[1]}`;
		const mo = (p[1] || '').match(/^(\d+)o$/);
		if (mo) return `gpt-${mo[1]}`;
		return p[1] ? `gpt-${p[1]}` : 'gpt'; // gpt-oss, or bare gpt (variant collapsed)
	}
	// OpenAI o-series: o1/o3/o4 are roots already.
	if (/^o\d+$/.test(p[0])) return p[0];
	// Anthropic: claude-<tier>-<major>, or claude-<major>(-minor)-<tier>.
	if (p[0] === 'claude') {
		if (['opus', 'sonnet', 'haiku'].includes(p[1]) && /^\d+$/.test(p[2] || '')) {
			return `claude-${p[1]}-${p[2]}`;
		}
		if (/^\d+$/.test(p[1] || '')) {
			const tierIdx = p.findIndex((t) => ['opus', 'sonnet', 'haiku'].includes(t));
			if (tierIdx > 0) return `claude-${p[1]}-${p[tierIdx]}`; // claude-3-5-haiku -> claude-3-haiku
			return key;
		}
		if (p[1] === 'fable') return 'claude-fable';
		return key;
	}
	// Google gemini / gemma: keep major(-minor), drop tier; gemma-3n -> gemma-3.
	if (p[0] === 'gemini' || p[0] === 'gemma') {
		const major = (p[1] || '').replace(/n$/, '');
		if (/^\d+$/.test(major)) {
			if (/^\d+$/.test(p[2] || '')) return `${p[0]}-${major}-${p[2]}`;
			return `${p[0]}-${major}`;
		}
		return p[1] ? `${p[0]}-${p[1]}` : p[0];
	}
	// Alibaba qwen: version may be baked into p[0] (qwen3, qwen3-5) or split (qwen-2-5).
	if (p[0].startsWith('qwen')) {
		if (p[0] === 'qwen' && /^\d+$/.test(p[1] || '')) {
			return /^\d+$/.test(p[2] || '') ? `qwen-${p[1]}-${p[2]}` : `qwen-${p[1]}`;
		}
		if (p[0] === 'qwen2') return /^\d+$/.test(p[1] || '') ? `qwen-2-${p[1]}` : 'qwen-2';
		if (/^qwen\d+$/.test(p[0]) && /^\d+$/.test(p[1] || '')) return `${p[0]}-${p[1]}`; // qwen3-5
		return p[0];
	}
	// Amazon nova: nova / nova-2.
	if (p[0] === 'nova') return /^\d+$/.test(p[1] || '') ? `nova-${p[1]}` : 'nova';
	// Cohere command-<series>: command-r / command-a (trailing digits already stripped).
	if (p[0] === 'command') return p[1] ? `command-${p[1].replace(/\d.*$/, '')}` : 'command';
	// Meta llama-<major>.
	if (p[0] === 'llama') {
		const m = (p[1] || '').match(/^(\d+)/);
		return m ? `llama-${m[1]}` : 'llama';
	}
	// Mistral families: drop the generation integer so a generation gap reads as the same family.
	if (['mistral', 'ministral', 'codestral', 'devstral', 'magistral', 'mixtral', 'voxtral', 'leanstral'].includes(p[0])) {
		if (p[0] === 'mistral' && p[1]) return `mistral-${p[1]}`; // mistral-large / -medium / -small / -nemo / -saba
		return p[0];
	}
	// DeepSeek lines: v3/v4 (incl. the deepseek-chat-vN alias), r1, math/prover/coder/vl; Janus.
	if (p[0] === 'deepseek' || p[0] === 'janus') {
		if (p[0] === 'janus') return 'janus';
		let m = key.match(/deepseek-(?:chat-)?v(\d+)/);
		if (m) return `deepseek-v${m[1]}`;
		m = key.match(/deepseek-(r\d+)/);
		if (m) return `deepseek-${m[1]}`;
		m = key.match(/deepseek-(math|prover|coder|vl)/);
		if (m) return `deepseek-${m[1]}`;
		return 'deepseek';
	}
	// xAI grok-<major>.
	if (p[0] === 'grok') {
		const m = (p[1] || '').match(/^(\d+)/);
		return m ? `grok-${m[1]}` : 'grok';
	}
	if (p[0] === 'jamba') return 'jamba';
	return key;
}

/**
 * Build the set of family roots we already track, scoped per provider, from loadCurrent()'s tracked
 * ids + aliases. Returns Set<"provider/familyRoot">.
 */
export function buildTrackedFamilyRoots(current) {
	const roots = new Set();
	if (!current || !current.knownByProvider) return roots;
	for (const [provider, ids] of current.knownByProvider) {
		for (const id of ids) {
			const root = familyRoot(normalizeModelKey(id));
			if (root) roots.add(`${provider}/${root}`);
		}
	}
	return roots;
}

/**
 * Decide whether a pending tripwire candidate is a GENUINELY-NEW model FAMILY worth surfacing, or
 * long-tail noise to drop. Returns { keep: boolean, reason: string|null } where reason is one of
 * 'size-tag' | 'quant' | 'variant-of-tracked' | 'known-family' when dropped, null when kept.
 *
 * Drops if ANY hold:
 *   1. size/MoE/expert-count SKU tag,
 *   2. quantization SKU tag,
 *   3. the stripped stem resolves to a tracked canonical id (alias-aware), OR the family root collapses
 *      to a bare vendor word (a pure variant of an existing family),
 *   4. the family root is already represented in the tracked-family set.
 * Provider coverage is assumed (the tripwire only emits our covered mainstream providers).
 */
export function classifyPendingCandidate({ provider, modelId }, { trackedFamilyRoots, current }) {
	const key = normalizeModelKey(modelId);
	if (!key) return { keep: false, reason: 'unparseable' };
	if (hasSizeTag(key)) return { keep: false, reason: 'size-tag' };
	if (hasQuantTag(key)) return { keep: false, reason: 'quant' };

	const stem = stripTrailingVariants(key);
	const resolvesToTracked = current && current.resolve && (current.resolve(provider, stem) || current.resolve(provider, key));
	const root = familyRoot(key);
	if (resolvesToTracked || BARE_VENDOR_ROOTS.has(root)) return { keep: false, reason: 'variant-of-tracked' };
	if (trackedFamilyRoots && trackedFamilyRoots.has(`${provider}/${root}`)) return { keep: false, reason: 'known-family' };

	return { keep: true, reason: null };
}

// ---------------------------------------------------------------------------
// makeRecord (contribution-form record builder; throws on anything invalid)
// ---------------------------------------------------------------------------

const VARIATIONS = new Set([
	'input', 'output', 'cache_read', 'cache_write', 'cache_write_5m', 'cache_write_1h',
	'batch_input', 'batch_output',
	'tier2_input', 'tier2_output', 'tier2_cache_read', 'tier2_cache_write',
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
