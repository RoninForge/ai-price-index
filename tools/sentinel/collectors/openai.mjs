// tools/sentinel/collectors/openai.mjs  (MIT)
// First-party OpenAI (GPT / o-series) price collector. KEYLESS.
//
// Source: https://developers.openai.com/api/docs/pricing  - a Next.js / React Server Components page.
// IMPORTANT (verified 2026-06-20): a plain fetch is rejected with HTTP 403. A browser-like
// User-Agent gets HTTP 200 (~528KB), so this collector sends Chrome-ish headers (UA + Accept +
// Accept-Language) and retries, mirroring collectors/google.mjs and collectors/xai.mjs.
//
// WHY THE RSC PAYLOAD, NOT THE TABLES (read before "fixing"): the page renders 16 <table> elements,
// but it ALSO embeds the same numbers in an escaped React-Server-Components / Flight payload. The
// payload is the complete, machine-shaped source of truth and is what every other reliable scrape on
// this page hangs off, so we parse it - exactly the pattern xai.mjs uses for the Grok docs page.
//
// PAYLOAD SHAPE (HTML-escaped: &quot; -> ", &lt; -> <). Each pricing table is a list of model rows of
// the form:
//   [1,[[0,"<model-name>"],[0,<input>],[0,<cache_read>],[0,<output>]]]
// i.e. the three price slots are, in order:  INPUT, CACHED-INPUT (cache_read), OUTPUT  (per 1M tokens).
// A cache slot may be a number, null, "-" or "" (no cached price) - all are treated as "no cache_read".
// Verified against current.json: gpt-4o -> [2.5, 1.25, 10], gpt-4.1 -> [2, 0.5, 8],
// o1 -> [15, 7.5, 60], gpt-5.5 (<272K) -> [5, 0.5, 30].
//
// TIERS - WE TAKE THE STANDARD TIER ONLY. The payload repeats every model across several tables
// (standard, then discounted/batch ~50% off, then a priority/long-context tier with a surcharge, e.g.
// gpt-4o appears as 2.5/1.25/10 then 1.25/-/5 then 4.25/2.125/17). We key by model name and KEEP THE
// FIRST tuple we see for each name, which is the standard tier in document order. The newer models also
// carry an explicit context-length tier in the NAME: "gpt-5.5 (<272K context length)" is the standard
// tier and "gpt-5.5 (>272K context length)" is the long-context tier; we match the "<" (or suffix-less)
// variant and ignore the ">" long-context tier. So gpt-5.5 standard = $5/$30, NOT the long-context
// $10/$45.
//
// Mapping: page display names map 1:1 to our canonical ids for the tracked set (the bare id, or the
// bare id followed by a " (<...context length)" suffix which we strip). gpt-4 and gpt-4-turbo are
// tracked by us but the page only carries DATED snapshots of them (gpt-4-0613, gpt-4-turbo-2024-04-09,
// ...), never the bare canonical id, so they are OMITTED here (we do not invent a snapshot->bare
// mapping). run.mjs will simply not see them from this source; that is intended.
//
// Contract (same as the other collectors): an array of
//   { provider:"openai", model_id, display_name, prices:{ input, output, cache_read? } (usd_per_mtok),
//     unit:"usd_per_mtok", source_url, source_kind:"provider_live", confidence:"verified",
//     known_mapping }
//
// Fail loud: if the price structure is not found (page went JS-only / 403 every retry / drifted), or if
// the post-build PIN (gpt-4o = $2.5 in / $10 out) disagrees, THROW. Never emit a guessed number.
//
// Zero new npm deps; Node ESM; built-in global fetch + AbortController. lib.fetchText sends neither a
// browser UA nor Accept-Language (the page 403s / could locale-negotiate), so this collector owns a
// small self-contained fetch that matches lib's timeout conventions.

export const PROVIDER = 'openai';
const SOURCE_URL = 'https://developers.openai.com/api/docs/pricing';

// Browser-like headers: the page 403s a non-browser UA, 200s a Chrome UA. Accept-Language pins English
// in case the docs ever locale-negotiate (ai.google.dev did).
const BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20000; // page is ~528KB; give it a touch more than lib's 15s
const MAX_FETCH_ATTEMPTS = 4; // tolerate transient 403/socket-close + locale misses

// The exact set of canonical model ids we track for OpenAI (mirrors data/ai-price-index index/current).
// Page names map to these either directly or after stripping a " (<...context length)" suffix.
const TRACKED = new Set([
	'gpt-4.1',
	'gpt-4o',
	'gpt-4o-mini',
	'gpt-5',
	'gpt-5.1',
	'gpt-5.2',
	'gpt-5.2-pro',
	'gpt-5.4',
	'gpt-5.4-mini',
	'gpt-5.4-nano',
	'gpt-5.4-pro',
	'gpt-5.5',
	'gpt-5.5-pro',
	'o1',
	'o1-mini',
	'o1-pro',
	'o3',
	'o3-deep-research',
	'o3-mini',
	'o3-pro',
	'o4-mini',
	'o4-mini-deep-research',
	// gpt-4 + gpt-4-turbo are tracked but the page only has dated snapshots; intentionally not listed.
]);

// PIN: gpt-4o is present on the page AND in current.json and is rock-stable. If the standard tuple ever
// stops resolving to $2.5 in / $10 out, the parse drifted or OpenAI changed it - either way, escalate.
const PIN_ID = 'gpt-4o';
const PIN_EXPECT = { input: 2.5, output: 10 };

function nearly(a, b) {
	return typeof a === 'number' && Math.abs(a - b) <= 1e-6;
}

/** True when a fetched body carries the embedded RSC price payload we anchor the parser on. */
function looksLikePricePayload(html) {
	// the escaped tuple marker + at least one known model name in the payload
	return /\[1,\[\[0,(?:&quot;|")gpt-/.test(html) || (html.includes('gpt-4o') && /per 1M/i.test(html));
}

/**
 * Fetch the pricing page with browser headers + a retry loop. The page 403s a non-browser UA and is
 * large; both a transient 403 and a mid-stream socket close are cheap to absorb with retries. Throws
 * only if every attempt fails to yield a body that contains the embedded price payload.
 */
async function fetchPricingHtml() {
	let lastHtml = '';
	let lastErr = null;
	for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(SOURCE_URL, {
				headers: {
					'user-agent': BROWSER_UA,
					'accept-language': 'en-US,en;q=0.9',
					accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				},
				signal: controller.signal,
				redirect: 'follow',
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			const html = await res.text();
			lastHtml = html;
			if (looksLikePricePayload(html)) return html;
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timer);
		}
		if (attempt < MAX_FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
	}
	if (!lastHtml && lastErr)
		throw new Error(`openai collector: fetch failed after ${MAX_FETCH_ATTEMPTS} attempts: ${lastErr.message}`);
	// Got a body but it never carried the payload: surface the precise drift error after parsing.
	return lastHtml;
}

/** Unescape the HTML entities the payload uses, so the JSON-ish tuples become plain text. */
function unescape(html) {
	return html
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

/**
 * Parse a single price slot from the payload (one of: a number like `2.5`, `null`, `"-"`, or `""`).
 * Returns a finite non-negative number, or null for any "no price" form.
 */
function parseSlot(raw) {
	if (raw == null) return null;
	let s = String(raw).trim();
	if (s === 'null') return null;
	// strip surrounding quotes if present ("-", "")
	if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
	if (s === '' || s === '-') return null;
	const n = parseFloat(s);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Map a raw page display name to a tracked canonical id, or null if it is not one we track.
 * Strips a trailing " (<272K context length)" / " (< ... )" suffix (the STANDARD tier) so the base id
 * is recovered. A ">" / "> ... context length" suffix (the LONG-CONTEXT tier) is rejected here so the
 * surcharged tier is never picked up.
 */
function canonicalFromName(rawName) {
	const name = rawName.trim();
	// long-context tier carries ">" in the suffix - never take it
	if (/\(\s*>/.test(name)) return null;
	// strip a standard-tier "(<...context length)" suffix
	const base = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
	return TRACKED.has(base) ? base : null;
}

/**
 * Collect OpenAI standard-tier prices from the embedded RSC payload.
 * Returns array of { provider, model_id, display_name, prices:{input,output,cache_read?},
 *                    unit, source_url, source_kind, confidence, known_mapping }. Fails loud on drift.
 */
export async function collect() {
	const rawHtml = await fetchPricingHtml();
	if (!looksLikePricePayload(rawHtml))
		throw new Error(
			'openai collector: pricing page has no embedded RSC price payload (escaped [1,[[0,"gpt-..."],...] ' +
				'tuples) - page is JS-only, 403-blocked, or drifted. Refusing to guess.'
		);

	const html = unescape(rawHtml);

	// Match each model row tuple: [1,[[0,"NAME"],[0,IN],[0,CACHE],[0,OUT]]]
	//   NAME : any run of non-quote chars (may contain spaces, parens, "<", etc.)
	//   slot : a number | null | "<quoted string>" (covers "-" and "")
	const SLOT = '(null|"[^"]*"|[0-9]+(?:\\.[0-9]+)?)';
	const rowRe = new RegExp(`\\[1,\\[\\[0,"([^"]+)"\\],\\[0,${SLOT}\\],\\[0,${SLOT}\\],\\[0,${SLOT}\\]\\]\\]`, 'g');

	const byId = new Map(); // canonical id -> { display, prices } (FIRST/standard tuple wins)
	let sawAnyRow = false;
	let m;
	while ((m = rowRe.exec(html))) {
		sawAnyRow = true;
		const rawName = m[1];
		const canonical = canonicalFromName(rawName);
		if (!canonical) continue; // not a tracked model, or the long-context tier
		if (byId.has(canonical)) continue; // keep the FIRST tuple = standard tier in document order

		const input = parseSlot(m[2]);
		const cache_read = parseSlot(m[3]);
		const output = parseSlot(m[4]);
		// a real text model row must have both input + output
		if (typeof input !== 'number' || typeof output !== 'number') continue;

		const prices = { input, output };
		if (typeof cache_read === 'number') prices.cache_read = cache_read;

		byId.set(canonical, { display: rawName.trim(), prices });
	}

	if (!sawAnyRow)
		throw new Error(
			'openai collector: found the payload marker but matched zero price-row tuples - structure drift. ' +
				'Refusing to guess.'
		);
	if (!byId.size)
		throw new Error(
			'openai collector: matched price-row tuples but none mapped to a tracked OpenAI model - ' +
				'name/structure drift. Refusing to guess.'
		);

	// UNIT/PARSE PIN: a known stable model must resolve to its known value, or escalate to a human.
	assertPin(byId);

	const results = [];
	for (const [model_id, { display, prices }] of byId) {
		results.push({
			provider: PROVIDER,
			model_id,
			display_name: display,
			prices,
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: true,
		});
	}
	return results;
}

/**
 * PIN: after building every record, assert gpt-4o's standard tuple is $2.5 in / $10 out. Guards against
 * an upstream re-scale silently rescaling every price, against a wrong-tier pick (e.g. taking the
 * long-context or batch tuple), and against an escaped-payload mis-parse. Throws on mismatch.
 */
function assertPin(byId) {
	const p = byId.get(PIN_ID);
	if (!p) {
		// gpt-4o is expected on this page; its absence means a name/structure drift the parser missed.
		throw new Error(
			`openai collector: PIN model "${PIN_ID}" not found among parsed rows - the page structure or ` +
				`its display name drifted. Refusing to emit a possibly-mis-parsed set.`
		);
	}
	if (!nearly(p.prices.input, PIN_EXPECT.input) || !nearly(p.prices.output, PIN_EXPECT.output)) {
		throw new Error(
			`openai collector: PIN FAILED for ${PIN_ID} - got input=${p.prices.input} output=${p.prices.output}, ` +
				`expected $${PIN_EXPECT.input}/$${PIN_EXPECT.output}. Either OpenAI changed the price, the parser ` +
				`picked the wrong tier (long-context/batch), or the payload scale changed; refusing to emit.`
		);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('openai collector failed:', e.message);
			process.exit(1);
		});
}
