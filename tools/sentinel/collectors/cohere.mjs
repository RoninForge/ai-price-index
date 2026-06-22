// tools/sentinel/collectors/cohere.mjs  (MIT)
// First-party, KEYLESS Cohere price collector.
//
// Source: https://cohere.com/pricing  - HTTP 200, ~558KB, served keyless with a browser UA. It is a
// Next.js app and has NO <table> elements.
//
// THE KEY TRAP (read this before "fixing" the parser): the VISIBLE raw HTML carries STALE LEGACY
// prices that WILL mislead a naive scraper - a FAQ paragraph literally states "Command R+ 08-2024
// pricing is $2.50/1M tokens for input and $10.00/1M tokens for output", plus an old "Command" and a
// dedicated-instance vault block. DO NOT parse the visible HTML. The CURRENT per-token API prices live
// only in the embedded Next.js RSC payload (`self.__next_f.push(...)` <script> blocks, ~32 of them),
// which carries the Sanity CMS data for each model card. Each model object has the shape (quotes are
// backslash-escaped inside the JS string, sometimes multiply):
//   {"_type":"model","modelName":"Command R","per":"1M tokens", ...,
//    "pricings":[{"_type":"pricing","inputLabel":"Input","inputPrice":0.15,
//                 "outputLabel":"Output","outputPrice":0.6}], ...}
// We anchor on `modelName` + the following `pricings`/`inputPrice`/`outputPrice` fields, NOT the cards
// nor the FAQ. We tolerate an arbitrary run of backslashes before every quote (like collectors/xai.mjs).
//
// UNIT (verified 2026-06-20): each model object carries `"per":"1M tokens"`, so `inputPrice` /
// `outputPrice` are ALREADY usd_per_mtok - no conversion. The collector REQUIRES `per` to say "1M
// tokens" for any model it emits; if Cohere ever switches the card to a per-token / per-1K scale the
// per-string changes and we refuse rather than mis-scale.
//
// WHAT THE PAGE CURRENTLY EXPOSES (2026-06-20) for the 4 models we track:
//   * Command R   -> command-r   : Input $0.15 / Output $0.6   (per-token API price, in payload)
//   * Command R7B -> command-r7b : Input $0.0375 / Output $0.15 (per-token API price, in payload; the PIN)
//   * Command A+  -> command-a-plus : the card is now the OPEN-WEIGHTS download tier only
//       ("API key" / "Model download", inputPrice 0 / outputPrice 0, "per":"Free") - the page no longer
//       advertises a per-token API price for it. We OMIT it (never emit the $0 free tier as the API
//       price, never invent the old $2.50/$10) and surface it in `missing`.
//   * Command R+  -> command-r-plus : NOT in the RSC payload at all (only in the stale FAQ). OMITTED.
// Models found with a real per-1M-token price are emitted; tracked-but-missing models are reported, not
// invented. The set the page exposes can grow/shrink - run.mjs decides NEW/CHANGED/UNCHANGED.
//
// PIN: after parsing, assert command-r7b == input 0.0375 / output 0.15 (verified first-party during the
// LiteLLM PR work). A mismatch THROWS so a real upstream change escalates to a human rather than
// silently flipping data; if the live payload genuinely differs the error prints the parsed values.
//
// Fail loud: if the RSC payload / inputPrice fields are absent, or no tracked model parses, THROW. Never
// emit a guessed number and never fall back to the stale visible-HTML prices.
//
// Contract (same as the other collectors): an array of
//   { provider:"cohere", model_id, display_name, aliases?,
//     prices:{ input, output } (usd_per_mtok),
//     unit:"usd_per_mtok", source_url, source_kind:"provider_live", confidence:"verified",
//     known_mapping }
//
// Zero new npm deps. lib.fetchText sends no Accept-Language and the page content-negotiates locale, so
// this collector owns a small self-contained fetch matching lib's UA/timeout conventions (like google.mjs).

export const PROVIDER = 'cohere';
const SOURCE_URL = 'https://cohere.com/pricing';

// Mirrors lib.mjs's fetch knobs so behavior matches the rest of the sentinel.
const USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 15000;
const MAX_FETCH_ATTEMPTS = 4; // tolerate transient socket closes / locale-negotiation misses

// Lower-cased Sanity `modelName` -> { model_id, aliases? } for the text chat models we track. Cards
// whose name is not here (North, Compass, Transcribe, Embed/Rerank, coding models) are skipped - we
// only price the tracked Command chat models. An unknown "Command ..." chat name slugs + surfaces NEW.
const NAME_TO_CANONICAL = {
	'command r': { model_id: 'command-r' },
	'command r7b': { model_id: 'command-r7b' },
	'command a+': { model_id: 'command-a-plus' },
	'command a plus': { model_id: 'command-a-plus' },
	'command r+': { model_id: 'command-r-plus' },
	'command r plus': { model_id: 'command-r-plus' },
};

// Models the dataset tracks for this provider; used only to compute the "missing" report.
const TRACKED = ['command-a-plus', 'command-r', 'command-r-plus', 'command-r7b'];

// PIN: command-r7b is first-party $0.0375 in / $0.15 out (verified during the LiteLLM PR work).
const PIN_ID = 'command-r7b';
const PIN_EXPECT = { input: 0.0375, output: 0.15 };
function nearly(a, b) {
	return typeof a === 'number' && Math.abs(a - b) <= 1e-6;
}

/** True when a fetched body carries the embedded RSC pricing payload we anchor the parser on. */
function looksLikePricingPayload(html) {
	return html.includes('self.__next_f.push') && /inputPrice/.test(html) && /\\?"modelName\\?"/.test(html);
}

/**
 * Fetch cohere.com/pricing with a browser UA + English Accept-Language and a retry loop. Marketing
 * sites can content-negotiate locale and Next.js pages occasionally close the socket mid-stream; both
 * are cheap to absorb. Throws only if every attempt fails to yield a body that carries the embedded
 * pricing payload (a true JS-only / drift signal).
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
					'user-agent': USER_AGENT,
					'accept-language': 'en-US,en;q=0.9',
					accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				},
				signal: controller.signal,
				redirect: 'follow',
			});
			if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
			const html = await res.text();
			lastHtml = html;
			if (looksLikePricingPayload(html)) return html;
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timer);
		}
		if (attempt < MAX_FETCH_ATTEMPTS) await new Promise((r) => setTimeout(r, 400 * attempt));
	}
	if (!lastHtml && lastErr)
		throw new Error(`cohere collector: fetch failed after ${MAX_FETCH_ATTEMPTS} attempts: ${lastErr.message}`);
	// Got a body but it never carried the payload: return it so collect() can throw the precise drift error.
	return lastHtml;
}

// Read a string field by name out of a serialized (possibly multiply backslash-escaped) model block.
// `key:"<value>"` with any run of backslashes before each quote.
function grabStr(blk, key) {
	const re = new RegExp(key + '[\\\\"]*:[\\\\"]*([^\\\\"]+)[\\\\"]');
	const m = blk.match(re);
	return m ? m[1] : null;
}

// Read a numeric field by name: `key:0.15` (NOT quoted; backslash-tolerant before the key's quote).
function grabNum(blk, key) {
	const re = new RegExp(key + '[\\\\"]*:\\s*(-?[0-9]+(?:\\.[0-9]+)?)');
	const m = blk.match(re);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) ? n : null;
}

/**
 * Parse the embedded Sanity `model` objects out of the RSC payload. Each model card serializes as a
 * `modelName` field followed (within the same object) by its `per` unit string and a `pricings` array
 * with `inputPrice` / `outputPrice`. We window from each `modelName` to the next so a card's fields
 * never leak into the next card, and read by field name (order-independent). Throws on structure drift.
 */
function parseModels(html) {
	if (!looksLikePricingPayload(html))
		throw new Error(
			'cohere collector: cohere.com/pricing has no embedded RSC pricing payload ' +
				'(self.__next_f / modelName / inputPrice) - page is JS-only or drifted. ' +
				'Refusing to guess and refusing to read the stale visible-HTML FAQ prices.'
		);

	// Every model card's name marker (backslash-tolerant), with its position.
	const nameRe = /[\\"]*modelName[\\"]*:[\\"]*([^\\"]+)[\\"]/g;
	const marks = [];
	let m;
	while ((m = nameRe.exec(html))) marks.push({ name: m[1], index: m.index });
	if (!marks.length)
		throw new Error('cohere collector: RSC payload present but no modelName markers parsed - structure drift.');

	const byId = new Map(); // model_id -> { prices, display, known }
	for (let i = 0; i < marks.length; i++) {
		const name = marks[i].name;
		const start = marks[i].index;
		// window ends at the next model card (or a generous cap) so fields don't bleed across cards
		const end = i + 1 < marks.length ? marks[i + 1].index : Math.min(html.length, start + 4000);
		const blk = html.slice(start, end);

		const norm = name.toLowerCase().replace(/\s+/g, ' ').trim();
		const mapping = NAME_TO_CANONICAL[norm];
		// Only price tracked Command chat models. Skip North/Compass/Transcribe/Embed/Rerank/coding etc.
		if (!mapping) continue;
		const model_id = mapping.model_id;
		if (byId.has(model_id)) continue; // multiple copies of the list may be embedded; take the first

		const input = grabNum(blk, 'inputPrice');
		const output = grabNum(blk, 'outputPrice');
		if (typeof input !== 'number' || typeof output !== 'number') continue; // no price pair on this card

		// UNIT GUARD: the card must declare a per-1M-token price. The free open-weights download tier
		// (Command A+ today) declares "per":"Free" with inputPrice 0 - that is NOT the API per-token
		// price, so we skip it rather than emit $0 or invent the old number.
		const per = (grabStr(blk, 'per') || '').toLowerCase();
		const isPerMtok = /1m\b|1\s*m\b|1 ?million|per million/.test(per) || /1m tok/.test(per);
		if (!isPerMtok) continue; // Free / per-1K-searches / etc. - not a per-Mtok API price

		byId.set(model_id, {
			prices: { input, output },
			display: name,
			known: true,
			aliases: mapping.aliases,
		});
	}

	if (!byId.size)
		throw new Error(
			'cohere collector: found the RSC payload but extracted zero tracked per-Mtok Command models - structure drift.'
		);

	// PIN: command-r7b must come out at $0.0375 / $0.15. If present and wrong, a real change or mis-parse.
	if (byId.has(PIN_ID)) {
		const p = byId.get(PIN_ID).prices;
		if (!nearly(p.input, PIN_EXPECT.input) || !nearly(p.output, PIN_EXPECT.output)) {
			throw new Error(
				`cohere collector: unit pin FAILED for ${PIN_ID} - got input=${p.input} output=${p.output}, ` +
					`expected $${PIN_EXPECT.input}/$${PIN_EXPECT.output}. Either the page drifted/mis-parsed or ` +
					`Cohere changed the price; refusing to emit. (Payload values printed above.)`
			);
		}
	}

	return byId;
}

/**
 * Collect first-party Cohere prices (keyless).
 * Returns an array of:
 *   { provider, model_id, display_name, aliases?, prices:{ input, output } (usd_per_mtok),
 *     unit, source_url, source_kind, confidence, known_mapping }
 * Fails loud on missing payload / zero models / a failed unit pin.
 */
export async function collect() {
	const html = await fetchPricingHtml();
	const byId = parseModels(html);

	const rows = [];
	for (const [model_id, { prices, display, known, aliases }] of byId) {
		rows.push({
			provider: PROVIDER,
			model_id,
			display_name: display,
			aliases: aliases && aliases.length ? aliases : undefined,
			prices,
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: known,
		});
	}
	return rows;
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
			console.error('cohere collector failed:', e.message);
			process.exit(1);
		});
}
