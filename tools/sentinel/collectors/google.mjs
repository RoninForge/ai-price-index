// tools/sentinel/collectors/google.mjs  (MIT)
// First-party Google (Gemini) price collector. This page is the hardest in the set.
//
// Source: https://ai.google.dev/gemini-api/docs/pricing  - server-rendered, but ONE small table per
// model (Standard / Batch sub-tables), each headed by an <hN> with the model name. Verified shape
// (2026-06-20): each model's Standard table has rows whose first cell is "Input price" / "Output
// price ..." and whose Paid-Tier cell is one of:
//   tiered:     "$1.25, prompts $2.50, prompts > 200k tokens"   (standard then the >200k tier)
//   flat:       "$0.30 (text / image / video) $1.00 (audio)"    (first $ = text input; audio is NOT a tier)
//
// Mapping (PAID tier only, text chat models we track):
//   standard input  -> input          first "$" in the Input-price paid cell
//   standard output -> output         first "$" in the Output-price paid cell
//   >200k input     -> tier2_input    second "$", ONLY when the cell marks a ">200k" / "200,000" tier
//   >200k output    -> tier2_output   ditto
// All prices are per 1M tokens -> usd_per_mtok. Image / video / TTS / embedding / Live models are
// skipped (we only emit a heading that maps to a tracked text model, OR a "Gemini ... Pro/Flash"
// heading that is plainly a text chat model; the long tail of media models is filtered by NAME).
//
// Fail loud: if no model heading with an "Input price" row is found, THROW (page went JS-only/drifted).
//
// NON-DETERMINISM FIX (2026-06-20): Google's edge content-negotiates the locale. With NO
// Accept-Language header (lib.mjs's fetchText sends none) the page is served in a RANDOM
// machine-translated locale - the <html lang> rotates through "zh-TW-x-mtfrom-en", "ja-x-mtfrom-en",
// "fr-x-mtfrom-en", ... and only ~2-in-10 requests land on English. The structure is identical
// (same `pricing-table` markup, same $ prices) but every label is translated, so the
// English-anchored parser ("Input price" / "Output price") rejected ~80% of responses. Sending
// `Accept-Language: en-US,en;q=0.9` forces the English variant deterministically (10/10 in testing).
// We can't change lib.mjs's fetchText to pass the header, so we fetch here with the header AND retry
// up to MAX_FETCH_ATTEMPTS, accepting only an English-price variant; we throw the drift error only
// if EVERY attempt fails to yield English price content (a true JS-only/drift signal).
//
// DEPRECATION SKIP (2026-06-22): a retired model must NOT be drafted as a NEW current price. The page
// flags a deprecated model with an `<aside class="warning">` placed BETWEEN the model's heading-group
// and its first pricing table, e.g. for gemini-2.0-flash / gemini-2.0-flash-lite (shut down June 1,
// 2026):
//   <div class="heading-group"><h2 ...>Gemini 2.0 Flash</h2><em><code>gemini-2.0-flash</code></em></div>
//   <aside class="warning"><b>Warning:</b> Gemini 2.0 Flash is
//     <a href="/gemini-api/docs/deprecations">deprecated</a> and has been shut down June 1, 2026. ...</aside>
//   <table class="pricing-table"> ... </table>
// We key off that aside (a warning aside whose body says deprecated/discontinued/retired/shut(-)down/
// sunset OR links to /docs/deprecations) sitting in [modelHeading, firstTable). We do NOT name-blocklist
// gemini-2.0-* - the marker generalizes to any future retirement. Current models (gemini-3.x,
// gemini-2.5-x) carry no such aside and are kept. Fail loud: if the ARTICLE BODY says "deprecat" but
// we detect ZERO deprecation asides, the marker drifted - THROW rather than silently re-emit a
// retired model as a NEW current price. Google may instead DELIST a retired model outright, in which
// case the body is clean, no aside exists, and the collector simply stops seeing it.

export const PROVIDER = 'google';
const SOURCE_URL = 'https://ai.google.dev/gemini-api/docs/pricing';

// Mirrors lib.mjs's fetch knobs so behavior matches the rest of the sentinel.
const USER_AGENT = 'ai-price-index price-sentinel (+https://roninforge.org)';
const FETCH_TIMEOUT_MS = 15000;
const MAX_FETCH_ATTEMPTS = 4; // up to 4 tries to land on the English-served variant

/** True when a fetched body is the English variant whose price labels the parser anchors on. */
function looksEnglishAndPriced(html) {
	return /Input price/.test(html) && /Output price/.test(html);
}

/**
 * Fetch the pricing page in ENGLISH, deterministically. Sends Accept-Language: en so Google's edge
 * stops rotating machine-translated locales, and retries up to MAX_FETCH_ATTEMPTS until the body is
 * the English-price variant. Throws only if every attempt failed to produce English price content.
 */
async function fetchEnglishPricingHtml() {
	let lastHtml = '';
	let lastErr = null;
	for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(SOURCE_URL, {
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
			if (looksEnglishAndPriced(html)) return html;
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timer);
		}
		// brief linear backoff between attempts (matches lib.mjs's batch-job cadence)
		if (attempt < MAX_FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
	}
	// All attempts exhausted. If we never got a 2xx body at all, surface the network error;
	// otherwise return the last body so collect() can emit the precise drift error after parsing.
	if (!lastHtml && lastErr) throw new Error(`google collector: fetch failed after ${MAX_FETCH_ATTEMPTS} attempts: ${lastErr.message}`);
	return lastHtml;
}

// Lower-cased model heading -> canonical id we publish. Unknown text headings slug + surface as NEW.
const NAME_TO_CANONICAL = {
	'gemini 3.5 flash': 'gemini-3.5-flash',
	'gemini 3.1 flash-lite': 'gemini-3.1-flash-lite',
	'gemini 3.1 pro preview': 'gemini-3.1-pro-preview',
	'gemini 3 flash preview': 'gemini-3-flash-preview',
	'gemini 2.5 pro': 'gemini-2.5-pro',
	'gemini 2.5 flash': 'gemini-2.5-flash',
	'gemini 2.5 flash-lite': 'gemini-2.5-flash-lite',
	'gemini 2.0 flash': 'gemini-2.0-flash',
	'gemini 1.5 pro': 'gemini-1.5-pro',
	'gemini 1.5 flash': 'gemini-1.5-flash',
};

// A deprecation/retirement warning aside on this page. Google wraps each retired model's notice in an
// `<aside class="warning">...</aside>` placed right after the model heading-group. We treat such an
// aside as a deprecation marker when its body carries an explicit retirement word OR links to the
// deprecations doc. Matched on the RAW aside HTML (links/words are inside <a>/<b> tags).
const WARNING_ASIDE_RE = /<aside\b[^>]*\bclass="[^"]*\bwarning\b[^"]*"[^>]*>([\s\S]*?)<\/aside>/gi;
const DEPRECATION_WORDS_RE = /(deprecat|discontinu|retir|shut[\s-]*down|sunset)/i;
const DEPRECATION_LINK_RE = /\/gemini-api\/docs\/deprecations/i;

// The devsite chrome carries the word "deprecated" on every render (a left-nav link to
// /gemini-api/docs/deprecations, plus a `.deprecated` inline-CSS rule), so the drift check below must
// read the ARTICLE BODY only or it fires on a page with no deprecated model on it at all.
const ARTICLE_BODY_OPEN_RE = /<div\b[^>]*\bclass="[^"]*\bdevsite-article-body\b[^"]*"[^>]*>/i;

/** The pricing article's own HTML, with the surrounding devsite nav/footer chrome removed. */
function articleBody(html) {
	const m = ARTICLE_BODY_OPEN_RE.exec(html);
	if (!m)
		throw new Error(
			'google collector: no devsite-article-body container on the pricing page - structure drift.'
		);
	const rest = html.slice(m.index + m[0].length);
	const end = rest.search(/devsite-content-footer/i);
	return end > 0 ? rest.slice(0, end) : rest;
}

/** True if an aside's inner HTML reads as a deprecation/retirement notice for a model. */
function isDeprecationAside(innerHtml) {
	return DEPRECATION_WORDS_RE.test(innerHtml) || DEPRECATION_LINK_RE.test(innerHtml);
}

// A heading that is a TEXT chat model worth pricing. Excludes image (🍌/Image), video, TTS, Live,
// Translate, embedding, Audio, Computer Use, Robotics, etc. We keep "Gemini <ver> Pro/Flash[-Lite]".
const TEXT_MODEL_HEADING_RE = /^Gemini [\d.]+ (?:Pro|Flash)(?:-Lite| Preview| Lite)?$/i;
// media/non-text heading words to hard-exclude even if the above ever loosened
const NON_TEXT_RE = /(image|video|tts|live|translate|embedding|audio|nano banana|robotics|computer use|guard|🍌)/i;

function cleanCell(s) {
	return s
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&#36;|&dollar;/g, '$')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** All "$X.XX" numbers in a cell, in order. */
function allPrices(s) {
	const out = [];
	const re = /\$\s*([0-9]+(?:\.[0-9]+)?)/g;
	let m;
	while ((m = re.exec(s))) {
		const n = parseFloat(m[1]);
		if (Number.isFinite(n)) out.push(n);
	}
	return out;
}

function slugify(name) {
	return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

/** From a Paid-Tier cell, return { std, tier2 } prices. tier2 only when the cell marks a >200k tier. */
function parseTierCell(cell) {
	const nums = allPrices(cell);
	if (!nums.length) return null;
	const std = nums[0];
	let tier2 = null;
	if (/(>\s*200,?000|>\s*200k|200,?000 tokens|> 200k)/i.test(cell) && nums.length >= 2) {
		tier2 = nums[1];
	}
	return { std, tier2 };
}

/**
 * Collect Gemini PAID-tier text-model prices.
 * Returns array of { provider, model_id, display_name, prices:{input,output,tier2_input?,tier2_output?},
 *                    unit, source_url, source_kind, confidence, known_mapping }. Fails loud on drift.
 */
export async function collect() {
	const html = await fetchEnglishPricingHtml();

	// Collect headings + their positions.
	const heads = [...html.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map((m) => ({
		text: cleanCell(m[1]),
		idx: m.index,
	}));
	// Collect tables + positions.
	const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => ({ html: m[0], idx: m.index }));
	if (!tables.length) throw new Error('google collector: no <table> on the pricing page - structure drift.');

	// Collect deprecation/retirement warning asides + positions (see DEPRECATION SKIP note above).
	const deprecationAsides = [...html.matchAll(WARNING_ASIDE_RE)]
		.filter((m) => isDeprecationAside(m[1]))
		.map((m) => ({ idx: m.index }));
	// Fail loud on marker drift: the page clearly marks deprecations in prose ("deprecat..." appears),
	// yet our aside detector found none -> the warning markup changed and we'd silently re-emit retired
	// models as NEW current prices. Refuse rather than guess.
	if (/deprecat/i.test(articleBody(html)) && deprecationAsides.length === 0)
		throw new Error(
			'google collector: page text mentions deprecation but no deprecation <aside class="warning"> was matched - deprecation marker drifted. Refusing to risk emitting a retired model.'
		);

	// Is the model at `headingIdx` (whose Standard table starts at `tableIdx`) flagged deprecated?
	// A deprecation aside sits between the model heading-group and its first pricing table.
	const isDeprecatedModel = (headingIdx, tableIdx) =>
		deprecationAsides.some((a) => a.idx > headingIdx && a.idx < tableIdx);

	// For each table, find its nearest preceding MODEL heading (skip Standard/Batch/section headings).
	// Returns { text, idx } of that heading, or null. idx lets us bound the deprecation-aside check.
	const nearestModelHeading = (tableIdx) => {
		let found = null;
		for (const hd of heads) {
			if (hd.idx >= tableIdx) break;
			if (TEXT_MODEL_HEADING_RE.test(hd.text) && !NON_TEXT_RE.test(hd.text)) found = { text: hd.text, idx: hd.idx };
			// any media/non-text model heading also "claims" the tables under it, so a following
			// text-model table is never mis-attributed to it; clear when we pass a non-text model head.
			else if (/^Gemini /i.test(hd.text) && NON_TEXT_RE.test(hd.text)) found = null;
		}
		return found;
	};

	const byModel = new Map(); // canonical -> { display, known, prices }
	let sawAnyInputRow = false;

	for (const t of tables) {
		const head = nearestModelHeading(t.idx);
		if (!head) continue; // table does not belong to a tracked text model
		const heading = head.text;
		const norm = heading.toLowerCase().replace(/\s+/g, ' ').trim();
		const canonical = NAME_TO_CANONICAL[norm] || slugify(heading);
		// only take the FIRST (Standard) table per model; skip Batch / later tables
		if (byModel.has(canonical)) continue;
		// SKIP retired models: a deprecation aside sits between this model's heading and its first
		// table (e.g. gemini-2.0-flash / -flash-lite, shut down June 1, 2026). A retired model must not
		// be drafted as a NEW current price. Record the canonical so a later Batch table can't re-add it.
		if (isDeprecatedModel(head.idx, t.idx)) {
			byModel.set(canonical, null);
			continue;
		}

		const rows = [...t.html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
		let input = null,
			output = null,
			tier2_input = null,
			tier2_output = null;
		for (const r of rows) {
			const cells = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cleanCell(m[1]));
			if (cells.length < 2) continue;
			const label = cells[0].toLowerCase();
			const paid = cells[cells.length - 1]; // Paid Tier is the last column
			if (/^input price/.test(label)) {
				sawAnyInputRow = true;
				const parsed = parseTierCell(paid);
				if (parsed) {
					input = parsed.std;
					tier2_input = parsed.tier2;
				}
			} else if (/^output price/.test(label)) {
				const parsed = parseTierCell(paid);
				if (parsed) {
					output = parsed.std;
					tier2_output = parsed.tier2;
				}
			}
		}

		if (typeof input !== 'number' || typeof output !== 'number') continue;
		const prices = { input, output };
		if (typeof tier2_input === 'number') prices.tier2_input = tier2_input;
		if (typeof tier2_output === 'number') prices.tier2_output = tier2_output;

		byModel.set(canonical, { display: heading, known: Boolean(NAME_TO_CANONICAL[norm]), prices });
	}

	if (!sawAnyInputRow)
		throw new Error(
			'google collector: found tables but no "Input price" row under any model heading - page JS-rendered or drifted. Refusing to guess.'
		);

	const results = [];
	for (const [model_id, entry] of byModel) {
		if (!entry) continue; // null = a deprecated/retired model whose slot we claimed but never emit
		const { display, known, prices } = entry;
		results.push({
			provider: PROVIDER,
			model_id,
			display_name: display,
			prices,
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: known,
		});
	}

	if (!results.length)
		throw new Error('google collector: parsed tables but extracted zero text-model rows - structure drift.');
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('google collector failed:', e.message);
			process.exit(1);
		});
}
