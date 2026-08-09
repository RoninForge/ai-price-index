// tools/sentinel/collectors/xai.mjs  (MIT)
// First-party xAI (Grok) price collector - DUAL-MODE.
//
// WHY DUAL-MODE (read this before "fixing" it): the authenticated xAI API
// (GET https://api.x.ai/v1/language-models) is the long-term source of truth - it is clean,
// machine-readable, and impossible to mis-scrape. It REQUIRES an API key, and at the moment we
// cannot obtain one (xAI's payment processor rejects the card). So this collector runs in TWO modes
// and auto-upgrades the day a key appears, with ZERO future code change:
//
//   * XAI_API_KEY set + non-empty  -> AUTHENTICATED API path (the robust, primary source).
//       GET https://api.x.ai/v1/language-models with Authorization: Bearer $XAI_API_KEY, apply the
//       /10000 integer-scale unit conversion, and assert the pin (grok-4.3 / grok-4.20-0309-reasoning
//       = $1.25 in / $2.50 out). If the API call FAILS while a key is set, we THROW - the key should
//       work, so a failure must surface, not silently fall back.
//   * no XAI_API_KEY                -> KEYLESS HTML FALLBACK (this interim path). Scrape xAI's
//       first-party docs page https://docs.x.ai/developers/models. A missing key is NO LONGER an error
//       (the old "xai BLOCKED" throw is gone): no key just means "use HTML". We only throw if the
//       chosen path genuinely fails.
//
// THE HTML FALLBACK IS THE FALLBACK, NOT THE PRIMARY, AND IS EXPECTED TO NEED MAINTENANCE. Set
// XAI_API_KEY (create one at https://console.x.ai, add it as the XAI_API_KEY repo secret in CI) to
// switch automatically onto the robust machine-readable API. Treat any HTML-parse drift as a signal
// to get a key, not just to patch the scraper.
//
// HOW THE HTML PATH WORKS: the docs page has NO <table>; the full model list is embedded in the page
// and is the only complete + reliable source on it (the visible Input/Output price <span>s render for
// only ~2 models). xAI has shipped TWO embed shapes, so the parser handles both and picks whichever
// the live page carries:
//
//   * BLOB shape (current, verified 2026-07-27) at https://docs.x.ai/developers/models. A plain
//     server-rendered JSON blob in its own <script>:
//       globalThis.__XAI_PUBLIC_MODELS__={"clusterConfigs":[{"languageModels":[
//         {"name":"grok-4.3","promptTextTokenPrice":"12500","completionTextTokenPrice":"25000",
//          "cachedPromptTokenPrice":"2000","promptTextTokenPriceLongContext":"25000",
//          "completionTokenPriceLongContext":"50000","aliases":[...]}, ...]}, ...]}
//     Same field names and same integer scale as the API; values are plain numeric strings (no "$n"
//     marker) and the model list repeats across clusterConfigs, so we take the first copy of each name.
//
//   * FLIGHT shape (legacy, verified 2026-06-20, the shape this page served until ~2026-07). The RSC
//     payload (`self.__next_f.push(...)` <script> blocks) carrying `auth_mgmt.LanguageModel` objects:
//       {"$typeName":"auth_mgmt.LanguageModel","name":"grok-4.3",...,
//        "promptTextTokenPrice":"$n12500","completionTextTokenPrice":"$n25000",...}
//     Values carry the Next.js Flight "$n" number marker, and because the payload lives inside a JS
//     string the JSON quotes are backslash-escaped (sometimes multiply), so that parser tolerates any
//     run of backslashes before quotes.
//
// 2026-07-27 drift, for the record: the rebuilt docs page dropped the Flight payload in favour of the
// blob, which is what broke the collector. The /docs/models -> /developers/models 308 was NOT the
// cause (that redirect predates the break - Wayback has it on 2026-03-04 - and fetch follows it); the
// URL constant was moved to the canonical target anyway. Prices, field names and the /10000 scale were
// unchanged; only the embed shape moved. The legacy parser is kept because it costs ~30 lines and a
// docs rebuild can put it back. We anchor on English price content via Accept-Language: en-US,en;q=0.9
// (docs sites content-negotiate locale, like ai.google.dev did) and retry, mirroring collectors/google.mjs.
//
// UNIT (shared by both paths): the *_token_price fields are an INTEGER scale, NOT USD-per-token. The
// correct conversion is  usd_per_mtok = price_field / 10000  (grok-4.3: 12500 -> $1.25 in, 25000 ->
// $2.50 out). The post-build PIN asserts a known model (grok-4.3, else grok-4.20-0309-reasoning) comes
// out to exactly $1.25 / $2.50; a live disagreement THROWS so a real change escalates to a human
// rather than silently flipping data.
//
// Mapping (both paths):
//   prompt_text_token_price / promptTextTokenPrice                  -> input
//   completion_text_token_price / completionTextTokenPrice          -> output
//   cached_prompt_text_token_price / cachedPromptTokenPrice         -> cache_read
//   *_token_price_long_context / *TokenPriceLongContext             -> tier2_input / tier2_output
//
// Contract (same as the other collectors): an array of
//   { provider:"xai", model_id, display_name, aliases?,
//     prices:{ input, output, cache_read?, tier2_input?, tier2_output? } (usd_per_mtok),
//     unit:"usd_per_mtok", source_url, source_kind:"provider_live", confidence:"verified",
//     known_mapping }
// Fail loud on real structure/unit drift (no parseable English price content / no models / unit pin
// fails / API error when keyed). Never emit a guessed number.
//
// Zero new npm deps. lib.fetchJson cannot carry an Authorization header (API path) and lib.fetchText
// sends no Accept-Language (HTML path), so this collector owns small self-contained fetches that match
// lib's UA/timeout conventions.

export const PROVIDER = 'xai';
import { SourceUnavailableError } from '../lib.mjs';

const API_URL = 'https://api.x.ai/v1/language-models';
// Canonical docs URL since the 2026-07-27 rebuild. The old /docs/models 308-redirects here.
const HTML_URL = 'https://docs.x.ai/developers/models';

// Mirrors lib.mjs's fetch knobs so behavior matches the rest of the sentinel.
const USER_AGENT = 'ai-price-index price-sentinel (+https://roninforge.org)';
const FETCH_TIMEOUT_MS = 15000;
const MAX_FETCH_ATTEMPTS = 4; // tolerate transient socket closes + locale-negotiation misses

// Integer-scale price field -> usd_per_mtok. The pinned conversion, shared by both paths.
const SCALE = 10000;
function toMtok(field) {
	if (field == null) return null;
	const n = typeof field === 'number' ? field : parseFloat(String(field));
	if (!Number.isFinite(n) || n < 0) return null;
	return n / SCALE;
}

// Models we use to PIN the unit. Known first-party: grok-4.3 + grok-4.20-0309-reasoning are $1.25/$2.50.
const PIN_EXPECT = { input: 1.25, output: 2.5 };
const PIN_IDS = ['grok-4.3', 'grok-4.20-0309-reasoning'];
function nearly(a, b) {
	return typeof a === 'number' && Math.abs(a - b) <= 1e-6;
}

/**
 * Collect first-party Grok prices.
 *   * XAI_API_KEY present -> authenticated API path (robust, primary). Throws if the API fails.
 *   * no key             -> keyless HTML fallback (interim). Throws only on real parse/unit drift.
 * Returns an array of:
 *   { provider, model_id, display_name, aliases?,
 *     prices: { input, output, cache_read?, tier2_input?, tier2_output? } (usd_per_mtok),
 *     unit, source_url, source_kind, confidence, known_mapping }
 */
export async function collect() {
	const key = process.env.XAI_API_KEY;
	if (key && key.trim()) {
		// AUTHENTICATED API PATH (primary). A key is set, so any failure here MUST surface.
		const data = await keyedFetchJson(API_URL, key.trim());
		return parseApiModels(data);
	}
	// KEYLESS HTML FALLBACK (interim). No key is not an error - just use the docs page.
	const html = await fetchEnglishModelsHtml();
	return parseHtmlModels(html);
}

// ---------------------------------------------------------------------------
// AUTHENTICATED API PATH
// ---------------------------------------------------------------------------

// lib.fetchJson cannot carry an Authorization header, so this owns a small keyed fetch. Still uses the
// global fetch + a timeout, matching lib's conventions, with zero new deps.
async function keyedFetchJson(url, key) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			headers: {
				'user-agent': USER_AGENT,
				accept: 'application/json',
				authorization: `Bearer ${key}`,
			},
			signal: controller.signal,
			redirect: 'follow',
		});
		if (!res.ok) throw new SourceUnavailableError(`HTTP ${res.status} ${res.statusText} for ${url}`);
		const txt = await res.text();
		try {
			return JSON.parse(txt);
		} catch (e) {
			throw new Error(`invalid JSON from ${url}: ${e.message}`);
		}
	} finally {
		clearTimeout(timer);
	}
}

function parseApiModels(data) {
	const models = data && Array.isArray(data.models) ? data.models : null;
	if (!models) throw new Error('xai collector (API): response has no "models" array - structure drift.');

	const byId = new Map();
	const rows = [];
	for (const m of models) {
		const id = m && m.id;
		if (typeof id !== 'string' || !id) continue;
		const prices = buildPrices({
			input: m.prompt_text_token_price,
			output: m.completion_text_token_price,
			cache_read: m.cached_prompt_text_token_price,
			tier2_input: m.prompt_text_token_price_long_context,
			tier2_output: m.completion_text_token_price_long_context,
		});
		if (!prices) continue; // needs at least input + output
		const aliases =
			Array.isArray(m.aliases) && m.aliases.length
				? m.aliases.filter((a) => typeof a === 'string' && a && a !== id)
				: undefined;
		byId.set(id, prices);
		rows.push(makeRow(id, prices, aliases, API_URL));
	}

	if (!rows.length)
		throw new Error('xai collector (API): response parsed but extracted zero priced models - structure drift.');
	assertPin(byId, 'API');
	return rows;
}

// ---------------------------------------------------------------------------
// KEYLESS HTML FALLBACK PATH
// ---------------------------------------------------------------------------

const BLOB_MARKER = 'globalThis.__XAI_PUBLIC_MODELS__';

/** True when the body carries priced model fields at all (either embed shape needs them). */
function hasPriceFields(html) {
	return /promptTextTokenPrice/.test(html) && /completionTextTokenPrice/.test(html);
}

/** True when the body carries the current server-rendered JSON blob. */
function hasBlobPayload(html) {
	return html.includes(BLOB_MARKER) && hasPriceFields(html);
}

/** True when the body carries the legacy Next.js RSC Flight payload. */
function hasFlightPayload(html) {
	return html.includes('auth_mgmt.LanguageModel') && hasPriceFields(html);
}

/** True when a fetched body carries an embedded model payload the parser can read. */
function looksLikeModelsPayload(html) {
	return hasBlobPayload(html) || hasFlightPayload(html);
}

/**
 * Fetch the docs/models page with an English Accept-Language and a retry loop. Docs sites can
 * locale-negotiate (ai.google.dev did), and Next.js docs occasionally close the socket mid-stream;
 * both are cheap to absorb with retries. Throws only if every attempt fails to yield a body that
 * contains the embedded model payload (a true JS-only / drift signal).
 */
async function fetchEnglishModelsHtml() {
	let lastHtml = '';
	let lastErr = null;
	for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(HTML_URL, {
				headers: {
					'user-agent': USER_AGENT,
					'accept-language': 'en-US,en;q=0.9',
				},
				signal: controller.signal,
				redirect: 'follow',
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			const html = await res.text();
			lastHtml = html;
			if (looksLikeModelsPayload(html)) return html;
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timer);
		}
		if (attempt < MAX_FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
	}
	if (!lastHtml && lastErr)
		throw new SourceUnavailableError(
			`xai collector (HTML): fetch failed after ${MAX_FETCH_ATTEMPTS} attempts: ${lastErr.message}`
		);
	// Got a body but it never carried the payload: surface the precise drift error after parsing.
	return lastHtml;
}

// In the embedded RSC payload, integer-scale prices are encoded as the string "$nNNNN" (the "$n"
// is a Next.js Flight number marker). Pull the numeric tail.
function flightNum(raw) {
	if (typeof raw !== 'string') return null;
	const m = raw.match(/^\$n([0-9.]+)$/);
	return m ? parseFloat(m[1]) : null;
}

/**
 * Read the models page, whichever embed shape it currently ships. Prefers the blob (the shape xAI
 * serves today) and falls back to the legacy Flight payload. Throws only when neither is present.
 */
function parseHtmlModels(html) {
	if (hasBlobPayload(html)) return parseBlobModels(html);
	if (hasFlightPayload(html)) return parseFlightModels(html);
	throw new Error(
		'xai collector (HTML): models page has no embedded price payload - neither the ' +
			`${BLOB_MARKER} blob nor an auth_mgmt.LanguageModel Flight payload carries ` +
			'promptTextTokenPrice/completionTextTokenPrice. Page is JS-only or drifted again. ' +
			'Refusing to guess; set XAI_API_KEY to use the authenticated API instead.'
	);
}

/**
 * Slice the `globalThis.__XAI_PUBLIC_MODELS__={...}` object out of its <script> by brace-matching from
 * the first `{` (string-aware, so braces inside model names or notes cannot end the object early).
 * Returns the parsed object, or null if the marker/JSON is unreadable.
 */
function extractBlobJson(html) {
	const at = html.indexOf(BLOB_MARKER);
	if (at < 0) return null;
	const start = html.indexOf('{', at);
	if (start < 0) return null;
	let depth = 0;
	let inStr = false;
	let esc = false;
	for (let p = start; p < html.length; p++) {
		const c = html[p];
		if (inStr) {
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === '{') depth++;
		else if (c === '}' && --depth === 0) {
			try {
				return JSON.parse(html.slice(start, p + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}

/**
 * Parse the current blob shape: clusterConfigs[].languageModels[], plain JSON, price fields as plain
 * numeric strings on the same /10000 integer scale as the API. The same model list repeats once per
 * cluster config, so the first copy of each name wins. Throws on structure/unit drift.
 */
function parseBlobModels(html) {
	const payload = extractBlobJson(html);
	if (!payload || !Array.isArray(payload.clusterConfigs))
		throw new Error(
			`xai collector (HTML/blob): found ${BLOB_MARKER} but could not parse a clusterConfigs ` +
				'array out of it - structure drift.'
		);

	const byId = new Map(); // model_id -> built prices, for the post-build unit assertion
	const aliasesById = new Map();
	for (const cluster of payload.clusterConfigs) {
		const models = cluster && Array.isArray(cluster.languageModels) ? cluster.languageModels : [];
		for (const m of models) {
			const id = m && m.name;
			if (typeof id !== 'string' || !id || byId.has(id)) continue;

			const prices = buildPrices({
				input: m.promptTextTokenPrice,
				output: m.completionTextTokenPrice,
				cache_read: m.cachedPromptTokenPrice,
				tier2_input: m.promptTextTokenPriceLongContext,
				tier2_output: m.completionTokenPriceLongContext,
			});
			if (!prices) continue; // needs at least input + output

			byId.set(id, prices);
			const aliases = Array.isArray(m.aliases)
				? [...new Set(m.aliases.filter((a) => typeof a === 'string' && a && a !== id))]
				: [];
			aliasesById.set(id, aliases.length ? aliases : undefined);
		}
	}

	if (!byId.size)
		throw new Error(
			'xai collector (HTML/blob): parsed the models blob but extracted zero priced models - structure drift.'
		);

	assertPin(byId, 'HTML/blob');
	return [...byId].map(([id, prices]) => makeRow(id, prices, aliasesById.get(id), HTML_URL));
}

/**
 * Parse the legacy embedded `auth_mgmt.LanguageModel` objects out of the RSC payload. The JSON lives
 * inside a JS string, so quotes are backslash-escaped (sometimes multiply); every pattern below
 * tolerates an arbitrary run of backslashes before a quote via the `[\\"]*` fragments. Each model's
 * fields appear in a fixed window after its name, so we slice a generous window per model and read the
 * price fields by name (order-independent, like the other collectors). Returns array of rows. Throws
 * on structure/unit drift.
 */
function parseFlightModels(html) {
	// Locate each model: the marker `auth_mgmt.LanguageModel`, then a `name`:"<id>" field.
	const nameRe = /auth_mgmt\.LanguageModel[\\"]*,[\\"]*name[\\"]*:[\\"]*([a-zA-Z0-9.\-]+)[\\"]/g;
	const byId = new Map(); // model_id -> built prices, for the post-build unit assertion
	const aliasesById = new Map();
	const seen = new Set();
	let m;
	while ((m = nameRe.exec(html))) {
		const id = m[1];
		if (seen.has(id)) continue; // 3 copies of the list are embedded; take the first of each
		seen.add(id);

		// A single model's serialized object is short; a 1600-char window comfortably contains its
		// price fields without leaking into the next model.
		const blk = html.slice(m.index, m.index + 1600);
		const grab = (key) => {
			// key:"$nNNNN" with any run of backslashes before each quote
			const re = new RegExp(key + '[\\\\"]*:[\\\\"]*(\\$n[0-9.]+)');
			const mm = blk.match(re);
			return mm ? flightNum(mm[1]) : null;
		};

		const prices = buildPrices({
			input: grab('promptTextTokenPrice'),
			output: grab('completionTextTokenPrice'),
			cache_read: grab('cachedPromptTokenPrice'),
			tier2_input: grab('promptTextTokenPriceLongContext'),
			tier2_output: grab('completionTokenPriceLongContext'),
		});
		if (!prices) continue; // needs at least input + output

		byId.set(id, prices);
		aliasesById.set(id, extractAliases(blk, id));
	}

	if (!byId.size)
		throw new Error(
			'xai collector (HTML/flight): found the LanguageModel payload but extracted zero priced models - structure drift.'
		);

	assertPin(byId, 'HTML/flight');

	const rows = [];
	for (const [id, prices] of byId) rows.push(makeRow(id, prices, aliasesById.get(id), HTML_URL));
	return rows;
}

/** Pull the (string) aliases array for a model out of its serialized block. Backslash-tolerant. */
function extractAliases(blk, id) {
	const am = blk.match(/aliases[\\"]*:[\\"]*\[([^\]]*)\]/);
	if (!am) return undefined;
	const list = [...am[1].matchAll(/([a-zA-Z0-9.\-]+)/g)]
		.map((x) => x[1])
		.filter((a) => a && a !== id && !/^[0-9]+$/.test(a));
	const uniq = [...new Set(list)];
	return uniq.length ? uniq : undefined;
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Build a prices object (usd_per_mtok) from integer-scale fields. Returns null without input+output. */
function buildPrices({ input, output, cache_read, tier2_input, tier2_output }) {
	const prices = {};
	const i = toMtok(input);
	const o = toMtok(output);
	const cr = toMtok(cache_read);
	const t2i = toMtok(tier2_input);
	const t2o = toMtok(tier2_output);
	if (i !== null) prices.input = i;
	if (o !== null) prices.output = o;
	if (cr !== null) prices.cache_read = cr;
	if (t2i !== null) prices.tier2_input = t2i;
	if (t2o !== null) prices.tier2_output = t2o;
	if (typeof prices.input !== 'number' || typeof prices.output !== 'number') return null;
	return prices;
}

function makeRow(model_id, prices, aliases, sourceUrl) {
	return {
		provider: PROVIDER,
		model_id,
		display_name: model_id,
		aliases: aliases && aliases.length ? aliases : undefined,
		prices,
		unit: 'usd_per_mtok',
		source_url: sourceUrl,
		source_kind: 'provider_live',
		confidence: 'verified',
		known_mapping: true,
	};
}

/**
 * UNIT PIN: after building every record, assert a known model resolved to the expected prices. Guards
 * against an upstream unit-scale change silently rescaling every price, and (HTML path) against a
 * mis-parse of the escaped payload. We look for grok-4.3 first, then grok-4.20-0309-reasoning; both are
 * first-party $1.25 in / $2.50 out. Throws on mismatch (escalate to a human).
 */
function assertPin(byId, pathLabel) {
	const pinId = PIN_IDS.find((id) => byId.has(id));
	if (!pinId) return; // neither pin model present; the zero-rows guard already ran
	const p = byId.get(pinId);
	if (!nearly(p.input, PIN_EXPECT.input) || !nearly(p.output, PIN_EXPECT.output)) {
		throw new Error(
			`xai collector (${pathLabel}): unit pin FAILED for ${pinId} - got input=${p.input} output=${p.output}, ` +
				`expected $${PIN_EXPECT.input}/$${PIN_EXPECT.output}. Upstream may have changed the price scale ` +
				`(usd_per_mtok = price_field / ${SCALE}) or the page drifted; refusing to emit.`
		);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('xai collector failed:', e.message);
			process.exit(1);
		});
}
