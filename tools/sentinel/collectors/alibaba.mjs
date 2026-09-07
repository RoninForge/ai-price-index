// tools/sentinel/collectors/alibaba.mjs  (MIT)
// First-party, KEYLESS Alibaba (Qwen / Model Studio) price collector.
//
// SOURCE CHANGED 2026-06-28 (structure drift fix). alibabacloud.com/help is now a client-rendered React
// SPA (aliyun "help-portal-fe"); the old server-rendered pricing tables on /model-studio/models are gone
// (that page is now a capabilities overview with NO prices and NO <table>s - the cause of the old
// "no <table> ... JS-rendered or structure drift" error). The SPA fetches each doc body from a KEYLESS
// JSON content API:
//     GET https://www.alibabacloud.com/help/json/document_detail.json?nodeId=<id>&website=intl&language=en
//     -> { code, success, data: { content: "<the doc body as HTML>", docTitle, ... } }
// `website=intl` is REQUIRED: website=en returns an empty body; only `intl` yields the international USD doc.
//
// Pricing now lives in its OWN doc, "Model inference pricing" (/model-studio/model-pricing, nodeId 2987148),
// whose HTML body carries per-model tables shaped:
//   Model ID | Deployment scope | Mode | Input tokens per request | Input price (per 1 million tokens) |
//   Output price (per 1 million tokens) | [Free quota]
// The same model is priced once per Deployment scope (International / Chinese mainland / Global / Hong Kong
// (China)); the scopes DISAGREE, so there is no single canonical number. We anchor on the INTERNATIONAL
// scope - the canonical intl USD tier the published dataset tracks - and take the BASE tier (the first
// "0 Token<=..." input band, or "No tiered pricing" for flat-priced models). Prices are already USD per 1M
// tokens, so usd_per_mtok directly (the input-price column header is unit-guarded to say "per 1 million
// tokens"; a table whose price column is in any other unit is skipped, never mis-scaled).
//
// Validated 2026-06-28: the 8 previously-tracked models read identical prices to the live dataset
// (qwen3-max $1.2/$6, qwen-max $1.6/$6.4, qwen-plus $0.4/$1.2, qwen-flash $0.05/$0.4, qwen-turbo $0.05/$0.2,
// qwen3.5-plus $0.4/$2.4, qwen3.5-flash $0.1/$0.4, qwen3-coder-plus $1/$5), confirming the scope/band choice.
// Four new flagships are now also tracked (qwen3.6-flash, qwen3.6-plus, qwen3.7-max, qwen3.7-plus); the
// sentinel drafts them as NEW for human verification before publish.
//
// FAIL LOUD on structural drift: throws if the content API returns no body, the doc has no <table>, the
// "International" scope is absent, or ZERO tracked models resolve. A handful of individually-missing tracked
// models are reported (not invented, not thrown) so one removed model never kills the rest of the run.
//
// Contract (same as the other collectors): an array of
//   { provider:"alibaba", model_id, display_name, prices:{ input, output } (usd_per_mtok),
//     unit:"usd_per_mtok", source_url, source_kind:"provider_live", confidence:"verified", known_mapping }

import { fetchJson } from '../lib.mjs';

export const PROVIDER = 'alibaba';

// The keyless help content API for the "Model inference pricing" doc. SOURCE_URL is the human-citable page
// the doc renders as (used as the records' source_url); the API is what we actually fetch.
const PRICING_NODE_ID = '2987148';
const CONTENT_API = `https://www.alibabacloud.com/help/json/document_detail.json?nodeId=${PRICING_NODE_ID}&website=intl&language=en`;
const SOURCE_URL = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing';

// --- Context Cache ------------------------------------------------------------------------------
// Alibaba does NOT publish a per-model cache price. The model-pricing doc says outright that "the
// input prices in the tables below do not include cache prices" and points at the Context Cache doc,
// which prices caching only as MULTIPLIERS of the standard input price:
//     explicit cache creation = 125% of input, explicit cache hit = 10% of input, implicit hit = 20%.
// So the cache rows we publish are DERIVED, not read, and they carry their own provenance
// (`inferred`, sourced to the cache doc) via item.variation_provenance. See run.mjs draftRecordsFor.
//
// WE PARSE THE MULTIPLIERS OUT OF THE DOC RATHER THAN HARDCODING THEM. A constant would freeze
// today's rule into the collector and keep deriving from it silently after Alibaba changed it, which
// is the exact failure this dataset has now hit three times (anthropic cache_read column rename, xai
// tier2_cache_read, the Fable 5.1 0.025x break of the "universal" 0.1x rule). If the sentence moves,
// this throws instead of quietly publishing stale arithmetic.
//
// THE NAMED EXCEPTIONS ARE NOT DERIVABLE AND WE DO NOT GUESS THEM. The doc says the explicit cache
// hit price for qwen3.8-max, qwen3.8-max-0902, qwen3.8-flash and qwen3.8-2.4t-a95b "is not 10% of the
// standard input token price. For specific pricing, see the Model Studio console." The console is
// authenticated, so those rates are simply not public. They get NO record and a standing notice, so
// the gap stays visible rather than being papered over with a number the vendor contradicts.
const CACHE_NODE_ID = '2862577';
const CACHE_API = `https://www.alibabacloud.com/help/json/document_detail.json?nodeId=${CACHE_NODE_ID}&website=intl&language=en`;
const CACHE_SOURCE_URL = 'https://www.alibabacloud.com/help/en/model-studio/context-cache';

// Sentences that carry the multipliers. Each MUST match or the collector throws.
const MULT_PATTERNS = {
	cache_read: /cache hits are typically billed at only (\d+(?:\.\d+)?)% of that price/i,
	cache_write: /Content used to create a new cache is billed at (\d+(?:\.\d+)?)% of the standard input token price/i,
};
// Read for the record notes only: the automatic cache a caller gets without markers.
const IMPLICIT_PATTERN =
	/portion of the input served from the cache is typically billed at (\d+(?:\.\d+)?)% of the standard input token price/i;
// The sentence that names the models whose rate is NOT the published multiplier.
const EXCEPTION_PATTERN = /is not \d+% of the standard input token price\. For specific pricing, see the Model Studio console/i;


// The Qwen flagship/mainline models the dataset tracks. Matched against the FIRST whitespace-delimited
// token of the "Model ID" cell, so dated snapshots (qwen3.7-max-2026-05-20) and look-alikes
// (qwen-plus-character) never match. Third-party models Bailian also hosts (glm-*, deepseek-*) are
// intentionally excluded - they belong to their own providers, not alibaba.
const TRACKED = [
	'qwen3-max',
	'qwen3.5-plus',
	'qwen3.5-flash',
	'qwen3-coder-plus',
	'qwen-plus',
	'qwen-flash',
	'qwen-max',
	'qwen-turbo',
	// New flagships surfaced by the tripwire, now first-party-priced from this doc:
	'qwen3.6-flash',
	'qwen3.6-plus',
	'qwen3.7-max',
	'qwen3.7-plus',
	'qwen3.7-flash',
	'qwen3.8-flash',
	'qwen3.8-max',
	'qwen3-coder-flash',
	'qwen3-coder-next',
];

// Ids that ARE priced per-Mtok at International scope on this doc but that we deliberately do not
// track. Each entry is a REASON, so the notice below can stay silent about it without the silence
// being an accident. Anything priced here that matches neither TRACKED nor these rules is reported.
const UNTRACKED_RULES = [
	[/^(?!qwen)/, 'third-party model hosted on Bailian; belongs to its own provider, not alibaba'],
	[/-\d{4}-\d{2}-\d{2}$/, 'dated snapshot of a tracked family'],
	// Alibaba uses BOTH -YYYY-MM-DD and a bare -MMDD for snapshots (qwen3.8-max-0902). Only the first
	// form was covered, so -MMDD ids nagged as "untracked" every run from 2026-09-03. Month-bounded so
	// it cannot swallow a real id that happens to end in four digits.
	[/-(0[1-9]|1[0-2])\d{2}$/, 'dated snapshot (-MMDD form) of a tracked family'],
	[/-(preview|latest)$/, 'preview/latest alias, not a stable priced id'],
	[/-(us|intl|cn)$/, 'regional deployment variant of a tracked id'],
	[/(^|-)\d+(\.\d+)?[bt](-a\d+(\.\d+)?b)?(-|$)/, 'open-weight size SKU, not a mainline API model'],
	[
		/(^|-)(vl|omni|mt|livetranslate|rerank|asr|tts|audio|image|ocr|captioner|character|realtime)(-|$)/,
		'non-text or modality-specific SKU; the index tracks per-token text models',
	],
];

function untrackedReason(id) {
	for (const [re, reason] of UNTRACKED_RULES) if (re.test(id)) return reason;
	return null;
}

// Sanity bounds (usd_per_mtok). Far wider than any plausible Qwen price; outside means a parse/unit error.
const PRICE_MIN = 0.001;
const PRICE_MAX = 1000;

const CANONICAL_SCOPE_RE = /^International\b/i;

function cleanCell(s) {
	return String(s)
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&#36;|&dollar;/g, '$')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** First "$<number>" in a string -> number, or null. */
function parsePrice(s) {
	const m = String(s).match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) ? n : null;
}

/** True when the input-price column header declares a per-1M-token unit (so the value is usd_per_mtok). */
function isPerMtokHeader(label) {
	return /per\s*1\s*(?:million|m)\s*tokens|per\s*1,?0{3},?0{3}\s*tokens/i.test(String(label));
}

/** A row's "Input tokens per request" cell marks the BASE tier when it is the lowest band or untiered. */
function isBaseBand(cell) {
	const b = String(cell || '')
		.replace(/\s+/g, '')
		.toLowerCase();
	if (b === '') return true; // no band column on this table -> the single row IS the base
	if (b.startsWith('0')) return true; // "0Token<=1M" etc. (the first/lowest band)
	if (b.includes('notiered')) return true; // "No tiered pricing"
	return false;
}

function rowsOf(tableHtml) {
	return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
		[...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cleanCell(m[1]))
	);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// Out-of-band channel for models this collector SAW priced first-party but does not track. Without
// it the TRACKED allow-list makes a new model invisible rather than detected-and-skipped: qwen3.8-max
// sat first-party-priced on this very doc for 18 days while the tripwire reported it as "awaiting
// first-party price". Reset per collect() so a notice never outlives the run that produced it.
let notices = [];

/** Read by run.mjs after a successful collect(); see tools/sentinel/README.md. */
export function getNotices() {
	return notices;
}

/**
 * Collect Alibaba Qwen International-scope base-tier prices for every tracked model.
 * Returns an array of { provider, model_id, display_name, prices:{input,output}, unit, source_url,
 * source_kind, confidence, known_mapping, notes }. Throws on structural drift; reports missing models.
 */
/**
 * Read the Context Cache doc and return the multipliers, the International-scope explicit-cache
 * support list, and the models the doc declares are NOT on the published multiplier.
 * Throws on any structural drift: a missing multiplier sentence means we cannot derive honestly.
 */
async function fetchCacheRules() {
	const doc = await fetchJson(CACHE_API);
	const content = doc && doc.data && doc.data.content;
	if (!content || typeof content !== 'string')
		throw new Error(
			`alibaba collector (cache): content API responded (code=${doc && doc.code}) but carried no doc ` +
				`body for nodeId ${CACHE_NODE_ID}, so cache rates were NOT checked. See ${CACHE_SOURCE_URL}.`
		);
	const text = content.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');

	const multipliers = {};
	for (const [variation, re] of Object.entries(MULT_PATTERNS)) {
		const m = text.match(re);
		if (!m)
			throw new Error(
				`alibaba collector (cache): could not read the ${variation} multiplier from the Context Cache ` +
					`doc. The sentence this collector derives from has moved or been reworded, so every derived ` +
					`cache rate would be stale arithmetic. Refusing to emit. Re-read ${CACHE_SOURCE_URL}.`
			);
		const pct = parseFloat(m[1]);
		if (!Number.isFinite(pct) || pct <= 0 || pct > 500)
			throw new Error(`alibaba collector (cache): implausible ${variation} multiplier ${m[1]}%.`);
		multipliers[variation] = pct / 100;
	}
	const im = text.match(IMPLICIT_PATTERN);
	const implicitPct = im ? parseFloat(im[1]) : null;

	// Models the doc explicitly removes from the multiplier rule. Collected from every exception
	// sentence, so a newly-named model drops out of derivation on the next run without a code change.
	const exceptions = new Set();
	for (const m of text.matchAll(new RegExp('([a-z0-9.,\\-\\s]{0,160}?)' + EXCEPTION_PATTERN.source, 'gi'))) {
		for (const id of (m[1] || '').match(/qwen[0-9a-z.\-]+|deepseek-[0-9a-z.\-]+|glm-[0-9a-z.\-]+/gi) || [])
			exceptions.add(id.replace(/[.,]$/, '').toLowerCase());
	}
	if (!exceptions.size)
		throw new Error(
			'alibaba collector (cache): the Context Cache doc carries no parseable exception list. It has ' +
				'named per-model exceptions to the multiplier since 2026-09; reading none means the parse ' +
				'drifted, and deriving for every model would price the exceptions wrong. Refusing to emit.'
		);

	// International-scope explicit-cache support list.
	const intl = text.match(/following models are available in the International deployment scope\.(.{0,1400})/i);
	const supported = new Set(
		((intl && intl[1]) || '').match(/qwen[0-9a-z.\-]+/gi)?.map((x) => x.toLowerCase()) || []
	);
	if (!supported.size)
		throw new Error(
			'alibaba collector (cache): could not read the International-scope explicit-cache model list.'
		);

	return { multipliers, implicitPct, exceptions, supported };
}

export async function collect() {
	notices = [];
	const doc = await fetchJson(CONTENT_API);
	const content = doc && doc.data && doc.data.content;
	if (!content || typeof content !== 'string')
		// Stays a hard finding (kind:"parse"), never SourceUnavailableError: an empty body means alibaba
		// is unmonitored, and the "unavailable" class is the one that deliberately stops nagging. But the
		// message must not assert a CAUSE we did not observe - this fired once on 2026-08-21 and the doc
		// was intact minutes later, so the old wording ("the pricing doc id changed") stated our transient
		// failure as a fact about Alibaba. Report what we saw; list causes as possibilities.
		throw new Error(
			`alibaba collector: content API responded (code=${doc && doc.code}, success=${doc && doc.success}) ` +
				`but carried no doc body for nodeId ${PRICING_NODE_ID} (website=intl), so alibaba was NOT ` +
				`price-checked. Cause not established: this has occurred transiently. If it repeats, check ` +
				`whether the help content API or the pricing doc id changed at ${SOURCE_URL}.`
		);

	const tables = [...content.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
	if (!tables.length)
		throw new Error('alibaba collector: model-pricing doc body has no <table> - structure drift.');
	if (!/International/.test(content))
		throw new Error('alibaba collector: no "International" deployment scope in the pricing doc - structure/region drift.');

	const found = new Map(); // model_id -> { input, output }
	const untracked = new Map(); // model_id -> raw display text (priced first-party, not in TRACKED)
	for (const t of tables) {
		const rows = rowsOf(t);
		if (rows.length < 2) continue;
		const header = rows[0].map((c) => c.toLowerCase());
		const scopeCol = header.findIndex((c) => /deployment scope/.test(c));
		const inCol = header.findIndex((c) => /input price/.test(c));
		const outCol = header.findIndex((c) => /output price/.test(c));
		const bandCol = header.findIndex((c) => /input tokens per request/.test(c));
		if (scopeCol < 0 || inCol < 0 || outCol < 0) continue;
		// Unit guard: only parse tables whose price columns are per-1M-token (skip per-image/-second/etc.).
		if (!isPerMtokHeader(rows[0][inCol])) continue;

		for (let i = 1; i < rows.length; i++) {
			const r = rows[i];
			const id = (r[0] || '').trim().split(/\s+/)[0].toLowerCase();
			if (!id || !/^[a-z0-9]/.test(id)) continue;
			// Scope first, so an untracked model is reported once (at International) and not once per scope.
			if (!CANONICAL_SCOPE_RE.test((r[scopeCol] || '').trim())) continue;
			const input = parsePrice(r[inCol]);
			const output = parsePrice(r[outCol]);
			if (input === null || output === null) continue;
			if (!TRACKED.includes(id)) {
				if (!untrackedReason(id)) untracked.set(id, (r[0] || '').trim());
				continue;
			}
			if (found.has(id)) continue; // first International base row (in doc order) wins
			if (bandCol >= 0 && !isBaseBand(r[bandCol])) continue;
			found.set(id, { input: round6(input), output: round6(output) });
		}
	}

	if (!found.size)
		throw new Error(
			'alibaba collector: parsed the pricing doc but resolved ZERO tracked International prices - structure drift. Refusing to guess.'
		);

	for (const [model_id, display] of untracked) {
		notices.push({
			kind: 'untracked_model',
			provider: PROVIDER,
			model_id,
			display_name: display,
			source_url: SOURCE_URL,
			message:
				`"${display}" is priced per-1M-tokens at International scope on Alibaba's own Model Studio ` +
				`pricing doc but is in neither TRACKED nor UNTRACKED_RULES. Add it to TRACKED to start ` +
				`recording it, or add a rule to UNTRACKED_RULES with a reason to keep ignoring it.`,
		});
	}

	const cache = await fetchCacheRules();
	const cachePct = (v) => `${Math.round(cache.multipliers[v] * 1000) / 10}%`;
	const derivedNote =
		`DERIVED, not read: Alibaba publishes no per-model cache price. The Context Cache doc prices ` +
		`explicit caching as a multiplier of the standard input price (hit ${cachePct('cache_read')}, ` +
		`creation ${cachePct('cache_write')}), and this rate is that multiplier applied to the input price ` +
		`recorded from the pricing doc on the same day` +
		(cache.implicitPct
			? `. Implicit (automatic) caching is billed at ${cache.implicitPct}% of input instead and is not ` +
				`recorded separately; these rows are the EXPLICIT cache-marker rates`
			: '') +
		`. Recheck if either the multiplier or the input price moves.`;

	const results = [];
	for (const model_id of TRACKED) {
		const prices = found.get(model_id);
		if (!prices) continue; // missing -> reported by the CLI/run layer, never invented
		for (const [k, v] of Object.entries(prices)) {
			if (typeof v !== 'number' || !Number.isFinite(v) || v < PRICE_MIN || v > PRICE_MAX)
				throw new Error(
					`alibaba collector: ${model_id} ${k}=${v} out of sanity bounds [${PRICE_MIN}, ${PRICE_MAX}]. Refusing to emit.`
				);
		}

		const out = {
			provider: PROVIDER,
			model_id,
			display_name: model_id,
			prices: { input: prices.input, output: prices.output },
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: true,
			notes: 'International deployment scope (intl USD), Model Studio "Model inference pricing"; base/standard tier.',
		};

		// Derive the cache rows only where the doc's own rule actually applies.
		if (cache.exceptions.has(model_id)) {
			// The vendor states this model is NOT on the multiplier and prices it only in an
			// authenticated console. Publishing the derived number would contradict the source, and
			// publishing nothing silently would let a consumer re-derive the same wrong number, so the
			// gap is stated out loud on every run instead.
			notices.push({
				kind: 'unpriced_variation',
				provider: PROVIDER,
				model_id,
				display_name: model_id,
				source_url: CACHE_SOURCE_URL,
				message:
					`${model_id}: Alibaba's Context Cache doc states its cache-hit price is NOT the published ` +
					`multiplier and gives the rate only in the authenticated Model Studio console, so no ` +
					`cache_read/cache_write row can be published first-party. Deriving one would contradict ` +
					`the vendor. This stays unpriced until Alibaba publishes it or we hold a key.`,
			});
		} else if (cache.supported.has(model_id)) {
			out.prices.cache_read = round6(prices.input * cache.multipliers.cache_read);
			out.prices.cache_write = round6(prices.input * cache.multipliers.cache_write);
			const prov = { confidence: 'inferred', source_url: CACHE_SOURCE_URL, notes: derivedNote };
			out.variation_provenance = { cache_read: prov, cache_write: prov };
		}
		results.push(out);
	}
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((rows) => {
			const found = new Set(rows.map((r) => r.model_id));
			const missing = TRACKED.filter((id) => !found.has(id));
			console.log(JSON.stringify(rows, null, 2));
			if (missing.length) console.error('tracked-but-missing (omitted, not invented):', missing.join(', '));
		})
		.catch((e) => {
			console.error('alibaba collector failed:', e.message);
			process.exit(1);
		});
}
