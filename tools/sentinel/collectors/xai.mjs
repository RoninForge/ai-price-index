// tools/sentinel/collectors/xai.mjs  (MIT)
// First-party xAI (Grok) price collector.
//
// KEY REQUIREMENT (LOUD, NOT OPTIONAL):
//   xAI publishes prices ONLY from the authenticated endpoint below. There is no key-free public
//   price feed we trust. Therefore this collector REQUIRES process.env.XAI_API_KEY. If it is
//   missing/empty we THROW a clear, specific "xai BLOCKED: ..." error rather than silently skipping.
//   The orchestrator (run.mjs) catches per-collector throws into report.errors[], which is surfaced
//   prominently - so a missing key shows up as a LOUD, visible BLOCKED state (the desired behavior),
//   not a quiet skip and not a crash of the whole run.
//   Create a key at https://console.x.ai and set XAI_API_KEY locally / add it as the XAI_API_KEY
//   repo secret in CI.
//
// Source: GET https://api.x.ai/v1/language-models  with  Authorization: Bearer $XAI_API_KEY
// Response shape:
//   { models: [ {
//       id, aliases?,
//       prompt_text_token_price, cached_prompt_text_token_price, completion_text_token_price,
//       long_context_threshold,
//       prompt_text_token_price_long_context, completion_text_token_price_long_context,
//   } ] }
//
// UNIT (TRICKY, verified 2026): the *_token_price fields are an INTEGER scale, NOT USD-per-token.
// The correct conversion is  usd_per_mtok = price_field / 10000  (e.g. grok-4.3 reads
// prompt=12500 / completion=25000  ->  $1.25 in / $2.50 out). We PIN this with an assertion below:
// after converting we require a known model (grok-4.3, else grok-4.20-0309-reasoning) to come out to
// exactly $1.25 input / $2.50 output (within a tiny epsilon), and THROW if it does not - that guards
// against an upstream unit change silently rescaling every price.
//
// Mapping: prompt_text_token_price          -> input
//          completion_text_token_price      -> output
//          cached_prompt_text_token_price   -> cache_read
//          *_token_price_long_context       -> tier2_input / tier2_output
//
// Fail loud only on real structure drift (response missing models / zero priced rows / the unit pin
// fails) and on a missing key (BLOCKED). Never emit a guessed number.
//
// lib.fetchJson cannot carry an Authorization header, so this collector owns a small keyed fetch
// (global fetch + a timeout, matching lib's UA/timeout conventions, zero new deps).

export const PROVIDER = 'xai';
const SOURCE_URL = 'https://api.x.ai/v1/language-models';

// Integer-scale price field -> usd_per_mtok. The pinned conversion.
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
 * Collect first-party Grok prices from the xAI API.
 * Returns an array of:
 *   { provider, model_id, display_name, aliases?,
 *     prices: { input?, output?, cache_read?, tier2_input?, tier2_output? } (usd_per_mtok),
 *     unit, source_url, source_kind, confidence }
 * THROWS a clear "xai BLOCKED: ..." error when XAI_API_KEY is unset/empty (run.mjs records that in
 * report.errors[] as a prominent BLOCKED state, never a silent skip and never a crash of the run).
 * Throws on real structure drift / unit drift otherwise.
 */
export async function collect() {
	const key = process.env.XAI_API_KEY;
	if (!key) {
		throw new Error(
			'xai BLOCKED: XAI_API_KEY required - create a key at https://console.x.ai and set XAI_API_KEY ' +
				'(locally) / add it as the XAI_API_KEY repo secret (CI). xAI prices come only from the ' +
				'authenticated /v1/language-models endpoint.'
		);
	}
	const data = await keyedFetchJson(SOURCE_URL, key);
	return parseModels(data);
}

// lib.fetchJson cannot carry an Authorization header, so this collector owns its keyed fetch. It still
// uses the global fetch + a timeout, matching lib's conventions, with zero new deps.
async function keyedFetchJson(url, key) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 15000);
	try {
		const res = await fetch(url, {
			headers: {
				'user-agent': 'ai-price-index price-sentinel (+https://roninforge.org)',
				accept: 'application/json',
				authorization: `Bearer ${key}`,
			},
			signal: controller.signal,
			redirect: 'follow',
		});
		if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
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

function parseModels(data) {
	const models = data && Array.isArray(data.models) ? data.models : null;
	if (!models) throw new Error('xai collector: response has no "models" array - structure drift.');

	const results = [];
	const byId = new Map(); // model_id -> built prices, for the post-build unit assertion
	for (const m of models) {
		const id = m && m.id;
		if (typeof id !== 'string' || !id) continue;

		const prices = {};
		const input = toMtok(m.prompt_text_token_price);
		const output = toMtok(m.completion_text_token_price);
		const cacheRead = toMtok(m.cached_prompt_text_token_price);
		const t2in = toMtok(m.prompt_text_token_price_long_context);
		const t2out = toMtok(m.completion_text_token_price_long_context);
		if (input !== null) prices.input = input;
		if (output !== null) prices.output = output;
		if (cacheRead !== null) prices.cache_read = cacheRead;
		if (t2in !== null) prices.tier2_input = t2in;
		if (t2out !== null) prices.tier2_output = t2out;

		// Only emit models that have at least input + output.
		if (typeof prices.input !== 'number' || typeof prices.output !== 'number') continue;

		byId.set(id, prices);
		results.push({
			provider: PROVIDER,
			model_id: id,
			display_name: id,
			aliases:
				Array.isArray(m.aliases) && m.aliases.length
					? m.aliases.filter((a) => typeof a === 'string' && a && a !== id)
					: undefined,
			prices,
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: true,
		});
	}

	if (!results.length)
		throw new Error('xai collector: response parsed but extracted zero priced models - structure drift.');

	// UNIT PIN: after building every record, assert a known model resolved to the expected prices.
	// Guards against an upstream unit-scale change silently rescaling every price. We look for grok-4.3
	// first, then grok-4.20-0309-reasoning; both are first-party $1.25 in / $2.50 out.
	const pinId = PIN_IDS.find((id) => byId.has(id));
	if (pinId) {
		const p = byId.get(pinId);
		if (!nearly(p.input, PIN_EXPECT.input) || !nearly(p.output, PIN_EXPECT.output)) {
			throw new Error(
				`xai collector: unit pin FAILED for ${pinId} - got input=${p.input} output=${p.output}, ` +
					`expected $${PIN_EXPECT.input}/$${PIN_EXPECT.output}. Upstream may have changed the price ` +
					`scale (usd_per_mtok = price_field / ${SCALE}); refusing to emit.`
			);
		}
	}

	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			// A missing key is a LOUD BLOCKED state, not a crash: print the clear message and exit non-zero.
			console.error('xai collector:', e.message);
			process.exit(1);
		});
}
