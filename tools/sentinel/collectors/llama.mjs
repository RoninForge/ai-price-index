// tools/sentinel/collectors/llama.mjs  (MIT)
// Llama (Meta open-weights) reference-price collector.
//
// There is NO first-party Meta price - Meta ships weights, not a hosted API price. We therefore
// reference a DESIGNATED REFERENCE HOST (Together AI) as an aggregator source, ALWAYS labelled:
//   source_kind: "aggregator"
//   source_url:  the Together URL the figure came from
//   notes:       "No first-party Meta price; Together AI reference host."
//
// Why this collector does NOT blind-scrape https://www.together.ai/pricing:
//   That page is JS-rendered (~500KB) and prices are NOT cleanly co-located with model names. The old
//   "find the name, read the next two $X.XX in a 140-char window" heuristic silently grabbed the
//   FINE-TUNING price table (Llama 4 Scout $3.00/$7.50, Maverick $8/$20) instead of the serverless
//   INFERENCE price. That made Scout read ~30x OpenRouter's reseller price - a reference host cannot be
//   30x more expensive than a downstream reseller, which is exactly the cross-check tripwire that caught
//   it. So we do NOT trust a windowed scrape of that page.
//
// Instead we publish Together's genuine per-model SERVERLESS INFERENCE prices, each taken from Together's
// own per-model page / docs (the authoritative per-model source), recorded below with the URL it came
// from. These are real, current Together figures (verified June 2026), labelled "inferred" because
// Together is a live reference host, not Meta itself. One model (Llama 3.1 405B) is NOT on Together's
// serverless API at all; it falls back to a clearly-labelled "estimated" value.
//
// A live OpenRouter cross-check (meta-llama/* ids) runs as a SANITY GUARD: a reference host being
// cheaper than a downstream reseller is impossible, so if any emitted Together value comes in BELOW the
// cheapest OpenRouter reseller for that model we FAIL LOUD rather than publish a mis-stated number.
// (We deliberately do NOT cap on Together being more EXPENSIVE than OpenRouter - Together legitimately
// runs pricier than OpenRouter's cheapest reseller, e.g. Llama 3.3 70B at $1.04 vs ~$0.10.)
//
// There is no meta-llama provider in current.json/index.json today, so every Llama model is NEW.

import { fetchJson } from '../lib.mjs';

export const PROVIDER = 'meta-llama';
const PRICING_URL = 'https://www.together.ai/pricing';
const NOTE = 'No first-party Meta price; Together AI reference host.';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

// Verified Together AI serverless-inference reference prices (usd_per_mtok), June 2026.
// Each entry records the Together source URL the figure was read from and the OpenRouter id used for the
// downstream sanity cross-check. `confidence`:
//   "inferred"  - Together actively hosts the model and exposes a serverless price (the live reference).
//   "estimated" - Together does NOT host this model on its serverless API; value is a clearly-labelled
//                 cross-source estimate (still recorded against the Together pricing page as the host).
const TARGETS = [
	{
		model_id: 'llama-4-scout',
		display: 'Llama 4 Scout',
		// https://www.together.ai/models/llama-4-scout  (serverless: $0.18 in / $0.59 out per 1M)
		prices: { input: 0.18, output: 0.59 },
		confidence: 'inferred',
		source_url: 'https://www.together.ai/models/llama-4-scout',
		openrouter_id: 'meta-llama/llama-4-scout',
	},
	{
		model_id: 'llama-4-maverick',
		display: 'Llama 4 Maverick',
		// https://www.together.ai/models/llama-4-maverick  (serverless: $0.27 in / $0.85 out per 1M)
		prices: { input: 0.27, output: 0.85 },
		confidence: 'inferred',
		source_url: 'https://www.together.ai/models/llama-4-maverick',
		openrouter_id: 'meta-llama/llama-4-maverick',
	},
	{
		model_id: 'llama-3.3-70b',
		display: 'Llama 3.3 70B',
		// Together docs + model page: Llama-3.3-70B-Instruct-Turbo is $1.04 in / $1.04 out per 1M.
		// Genuinely pricier than OpenRouter's cheapest reseller (~$0.10/$0.32) - that is real, not a bug.
		prices: { input: 1.04, output: 1.04 },
		confidence: 'inferred',
		source_url: 'https://www.together.ai/models/llama-3-3-70b',
		openrouter_id: 'meta-llama/llama-3.3-70b-instruct',
	},
	{
		model_id: 'llama-3.1-405b',
		display: 'Llama 3.1 405B',
		// NOT available on Together's serverless API (model page: "not available on Together's Serverless
		// API"). Estimated from Together's historically-quoted 405B rate, consistent with Fireworks ($3.00).
		prices: { input: 3.5, output: 3.5 },
		confidence: 'estimated',
		source_url: PRICING_URL,
		openrouter_id: 'meta-llama/llama-3.1-405b-instruct', // typically absent from OpenRouter
	},
	{
		model_id: 'llama-3.1-8b',
		display: 'Llama 3.1 8B',
		// Together: Llama-3.1-8B-Instruct-Turbo is $0.18 in / $0.18 out per 1M (model page / cost calc).
		prices: { input: 0.18, output: 0.18 },
		confidence: 'inferred',
		source_url: 'https://www.together.ai/models/llama-3-1-8b-instruct-turbo',
		openrouter_id: 'meta-llama/llama-3.1-8b-instruct',
	},
];

// OpenRouter cross-check bounds (multiples of the cheapest OpenRouter reseller price for the same id).
//   FLOOR: a reference host should not undercut a downstream reseller. Allow a small float-noise margin.
//   CEIL:  the reference host (Together) legitimately runs PRICIER than OpenRouter's cheapest reseller -
//          e.g. Llama 3.3 70B at $1.04 vs ~$0.10 (~10x) is real and verified. But the original bug
//          (Llama 4 Scout drafted at $3 vs ~$0.10 = ~30x) was the serverless price being swapped for the
//          FINE-TUNING table. So we cap at a generous multiple that passes real Together premiums (10x)
//          yet fails loud on the fine-tuning-contamination signature (>=~15x).
const RESELLER_FLOOR_MULT = 0.9; // emitted must be >= 90% of the cheapest OpenRouter reseller
const RESELLER_CEIL_MULT = 12; // emitted must be <= 12x the cheapest OpenRouter reseller

/**
 * Fetch OpenRouter's model list and return a Map<openrouter_id, { input, output }> in usd_per_mtok for
 * the meta-llama ids we care about. Best-effort: returns an empty Map on any network/parse failure, so a
 * flaky OpenRouter does not block publishing Together's verified reference prices (the guard simply does
 * not run for missing ids).
 */
async function fetchOpenRouterLlamaPrices() {
	const out = new Map();
	let data;
	try {
		const j = await fetchJson(OPENROUTER_MODELS_URL);
		data = Array.isArray(j) ? j : j.data;
	} catch {
		return out; // best-effort cross-check only
	}
	if (!Array.isArray(data)) return out;
	const want = new Set(TARGETS.map((t) => t.openrouter_id));
	for (const m of data) {
		if (!m || typeof m.id !== 'string') continue;
		// match exact id, a ":variant" suffix (skip ":free"), or the canonical_slug
		const baseId = m.id.split(':')[0];
		const variant = m.id.includes(':') ? m.id.split(':')[1] : '';
		if (variant === 'free') continue; // $0 free tiers are not a real reseller floor
		const id = want.has(m.id) ? m.id : want.has(baseId) ? baseId : want.has(m.canonical_slug) ? m.canonical_slug : null;
		if (!id) continue;
		const p = m.pricing || {};
		const input = parseFloat(p.prompt) * 1e6;
		const output = parseFloat(p.completion) * 1e6;
		if (!Number.isFinite(input) || !Number.isFinite(output) || input <= 0 || output <= 0) continue;
		// keep the cheapest reseller seen for this id (the true downstream floor)
		const prev = out.get(id);
		if (!prev || input < prev.input) out.set(id, { input, output });
	}
	return out;
}

/**
 * Guard one target's emitted Together prices against the cheapest OpenRouter reseller, both directions:
 *   - below the FLOOR: a reference host should not undercut a downstream reseller.
 *   - above the CEIL:  an implausible premium (the fine-tuning-table contamination that produced the
 *                      original $3 Scout bug, ~30x the reseller).
 * Throws (fail loud) on either. Does nothing when OpenRouter has no usable price for the id.
 */
function assertWithinResellerBounds(target, orPrice) {
	if (!orPrice) return;
	for (const variation of ['input', 'output']) {
		const ours = target.prices[variation];
		const reseller = orPrice[variation];
		if (!Number.isFinite(ours) || !Number.isFinite(reseller) || reseller <= 0) continue;
		if (ours < reseller * RESELLER_FLOOR_MULT) {
			throw new Error(
				`llama collector: ${target.model_id} ${variation}=$${ours}/Mtok undercuts OpenRouter reseller ` +
					`$${reseller.toFixed(4)}/Mtok - a reference host cannot be cheaper than a reseller. Refusing to ` +
					`publish (likely a mis-stated Together figure).`
			);
		}
		if (ours > reseller * RESELLER_CEIL_MULT) {
			throw new Error(
				`llama collector: ${target.model_id} ${variation}=$${ours}/Mtok is >${RESELLER_CEIL_MULT}x the ` +
					`OpenRouter reseller $${reseller.toFixed(4)}/Mtok - implausible reference premium (the ` +
					`fine-tuning-table bug signature). Refusing to publish.`
			);
		}
	}
}

/**
 * Collect Together-reference Llama prices.
 * Returns an array of:
 *   { provider, model_id, display_name, prices:{input,output}, unit, source_url, source_kind,
 *     confidence, notes, scraped }
 * Each variation becomes its own contribution record downstream. confidence is "inferred" for models
 * Together actively hosts, "estimated" for models it does not host on serverless (Llama 3.1 405B).
 * A live OpenRouter cross-check runs as a sanity guard (fail loud if a value undercuts a reseller).
 */
export async function collect() {
	const orPrices = await fetchOpenRouterLlamaPrices();

	const results = [];
	for (const t of TARGETS) {
		assertWithinResellerBounds(t, orPrices.get(t.openrouter_id));
		results.push({
			provider: PROVIDER,
			model_id: t.model_id,
			display_name: t.display,
			prices: { input: t.prices.input, output: t.prices.output },
			unit: 'usd_per_mtok',
			source_url: t.source_url,
			source_kind: 'aggregator',
			confidence: t.confidence,
			notes: NOTE,
			scraped: false,
		});
	}
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('llama collector failed:', e.message);
			process.exit(1);
		});
}
