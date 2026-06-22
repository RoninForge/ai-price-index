// tools/sentinel/collectors/amazon.mjs  (MIT)
// First-party Amazon (Bedrock Nova) price collector.
//
// Source: the AWS Price List bulk JSON for Amazon Bedrock - machine-readable, no auth, no JS.
//   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json
// This is the BEST source for Bedrock: it is the same data the AWS pricing page renders.
//
// Shape: { products: { <sku>: { attributes: { model, inferenceType, usagetype, regionCode, feature, ... } } },
//          terms: { OnDemand: { <sku>: { <offerKey>: { priceDimensions: { <dk>: { pricePerUnit:{USD}, unit } } } } } } }
// We join products[sku].attributes to terms.OnDemand[sku].priceDimensions[].pricePerUnit.USD and normalize:
//   AWS quotes per 1K tokens, so usd_per_mtok = USD * 1000.
//
// ---------------------------------------------------------------------------
// SKU SELECTION - which `usagetype` carries the canonical on-demand price (the bug fix).
// ---------------------------------------------------------------------------
// For one (model, variation) AWS publishes MANY token SKUs that differ only by a `usagetype` suffix:
//   USE1-Nova2.0Lite-input-tokens                              0.33   feature "On-demand Inference"  <- single-region on-demand
//   USE1-Nova2.0Lite-input-tokens-cross-region-global          0.30   feature (none)                <- cross-region inference profile
//   USE1-Nova2.0Lite-input-tokens-batch                        0.165  feature "Batch Inference"
//   USE1-Nova2.0Lite-input-tokens-flex                         0.165  feature "On-demand Inference" (flex)
//   USE1-Nova2.0Lite-input-tokens-priority                     0.5775 feature "On-demand Inference" (priority)
//   USE1-Nova2.0Lite-input-tokens-custom-model                 0.30   feature "Model Customization"
//   ...plus -cross-region-global-batch, -flex-cross-region-global, -priority-cross-region-global, etc.
// The OLD collector took the first `-input-tokens`/`-output-tokens` SKU it saw (the 0.33/2.75 single-region
// one), which disagrees with our published canonical (0.30/2.50). AWS markets Nova 2.x at the cross-region
// inference-profile rate, and that is the number our dataset records.
//
// FILTER (the attribute filter that selects the base SKU):
//   We keep ONLY usagetypes whose suffix (after the "<region>-<Model>-" prefix) is EXACTLY one of:
//       (text-)?input-tokens                          -> the plain single-region on-demand SKU
//       (text-)?input-tokens-cross-region-global      -> the cross-region inference-profile SKU
//       (text-)?output-tokens                         (same two forms for output)
//       (text-)?output-tokens-cross-region-global
//   This is an ALLOWLIST anchored to end-of-string, so it deliberately EXCLUDES every other variant
//   (-batch, -flex, -priority, -custom-model, -latency-optimized, -standard, -*-cross-region-global-batch,
//   -flex-cross-region-global, -priority-cross-region-global, ...). Cross-region appears only as
//   "-cross-region-global" on Nova; the anchored regex admits nothing else.
//   Among the surviving candidates for a (model, variation) we take the MINIMUM USD: for Nova 1.x there is
//   exactly one candidate (the plain on-demand SKU); for Nova 2.x there are two (single-region vs the lower
//   cross-region-global profile) and the lower one is AWS's headline rate == our canonical value.
//   The candidate set can ONLY ever be {plain on-demand, cross-region-global}, so "minimum" cannot smuggle
//   in a batch/flex/priority discount - those usagetypes are not in the set.
//
// GOTCHAS (verified live 2026-06-20 against the bulk JSON):
//   * ServiceCode is AmazonBedrock (NOT AmazonBedrockFoundationModels, which has 0 Nova products).
//   * Canonical region us-east-1 (regionCode pin).
//   * Nova 2.0 Pro uses "text-input-tokens"/"text-output-tokens"; Nova 2.0 Lite + all Nova 1.x use plain
//     "input-tokens"/"output-tokens". The "(text-)?" in the regex catches both.
//   * Skip Canvas (per-image) / Reel (per-second) - they are not in MODEL_TO_CANONICAL and carry no
//     "*-tokens" usagetype anyway.
//
// Fail loud: if products/terms are missing, if a mapped model yields no candidate input/output SKU, or if
// no Nova text rows are extracted, THROW. Never emit a guessed number.

import { fetchJson } from '../lib.mjs';

export const PROVIDER = 'amazon';
const SOURCE_URL =
	'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrock/current/us-east-1/index.json';
// The human-facing first-party page the same numbers render on (used on the published record).
const PUBLIC_URL = 'https://aws.amazon.com/bedrock/pricing/';
const REGION = 'us-east-1';

// AWS "model" attribute (verbatim) -> the canonical id we publish, for the Nova TEXT models we track.
// Anything Nova that is not in this map (e.g. Nova Sonic/Omni/Canvas/Reel) is intentionally ignored;
// a brand-new Nova text model not yet mapped would fall through (unmapped -> skipped, not guessed).
const MODEL_TO_CANONICAL = {
	'Nova Micro': 'nova-micro',
	'Nova Lite': 'nova-lite',
	'Nova Pro': 'nova-pro',
	'Nova Premier': 'nova-premier',
	'Nova 2.0 Lite': 'nova-2-lite',
	// Nova 2.0 Pro is a real Bedrock text model not in our index yet -> kept so it surfaces as NEW.
	'Nova 2.0 Pro': 'nova-2-pro',
};

// Allowlist matchers for the canonical on-demand usagetype. The string is the FULL usagetype
// (e.g. "USE1-Nova2.0Lite-input-tokens-cross-region-global"); we only care about the tail.
// Exactly two accepted tails per variation: plain on-demand, or the cross-region-global profile.
const INPUT_RE = /-(?:text-)?input-tokens(?:-cross-region-global)?$/;
const OUTPUT_RE = /-(?:text-)?output-tokens(?:-cross-region-global)?$/;

/** Map a usagetype to our variation IFF it is an accepted on-demand base/cross-region SKU, else null. */
function usageToVariation(usagetype) {
	if (INPUT_RE.test(usagetype)) return 'input';
	if (OUTPUT_RE.test(usagetype)) return 'output';
	return null;
}

/** Pull the single USD pricePerUnit out of an OnDemand term for a sku. Returns a number or null. */
function priceForSku(onDemand, sku) {
	const t = onDemand[sku];
	if (!t) return null;
	for (const offerKey of Object.keys(t)) {
		const dims = (t[offerKey] && t[offerKey].priceDimensions) || {};
		for (const dk of Object.keys(dims)) {
			const usd = dims[dk] && dims[dk].pricePerUnit && dims[dk].pricePerUnit.USD;
			if (usd != null) {
				const n = parseFloat(usd);
				if (Number.isFinite(n)) return n;
			}
		}
	}
	return null;
}

/**
 * Collect normalized Nova text prices from the Bedrock Price List JSON.
 * Returns an array of:
 *   { provider, model_id, display_name, prices:{input,output} (usd_per_mtok),
 *     unit, source_url, source_kind, confidence, known_mapping, notes }
 * Fails loud on structure drift or zero extracted rows.
 */
export async function collect() {
	const data = await fetchJson(SOURCE_URL);
	const products = data && data.products;
	const onDemand = data && data.terms && data.terms.OnDemand;
	if (!products || typeof products !== 'object')
		throw new Error('amazon collector: Bedrock price list has no "products" object - structure drift.');
	if (!onDemand || typeof onDemand !== 'object')
		throw new Error('amazon collector: Bedrock price list has no "terms.OnDemand" object - structure drift.');

	// model id -> { display, candidates: { input: number[], output: number[] } }
	// We collect ALL accepted candidate SKUs per (model, variation), then reduce to the minimum below.
	const byModel = new Map();
	for (const sku of Object.keys(products)) {
		const a = (products[sku] && products[sku].attributes) || {};
		const display = a.model;
		if (!display || !MODEL_TO_CANONICAL[display]) continue; // only the Nova text models we track/surface
		if (a.regionCode && a.regionCode !== REGION) continue; // pin to the canonical region
		const variation = usageToVariation(a.usagetype || '');
		if (!variation) continue; // accepts ONLY plain on-demand + cross-region-global token SKUs

		const per1k = priceForSku(onDemand, sku);
		if (per1k === null) continue; // no on-demand USD term for this sku
		// AWS quotes per 1K tokens; *1000 -> per MTok. Round to 6dp to shed binary-float noise
		// (0.000035*1000 = 0.0349999...) without altering any real published rate.
		const perMtok = Math.round(per1k * 1000 * 1e6) / 1e6;

		const canonical = MODEL_TO_CANONICAL[display];
		const bucket = byModel.get(canonical) || { display, candidates: { input: [], output: [] } };
		bucket.candidates[variation].push(perMtok);
		byModel.set(canonical, bucket);
	}

	const results = [];
	for (const [model_id, { display, candidates }] of byModel) {
		// Reduce each variation's candidate set to the canonical on-demand rate = the minimum of
		// {single-region on-demand, cross-region-global profile}. AWS markets Nova at the cross-region
		// rate where it exists (Nova 2.x); Nova 1.x has a single candidate so min is a no-op there.
		const prices = {};
		if (candidates.input.length) prices.input = Math.min(...candidates.input);
		if (candidates.output.length) prices.output = Math.min(...candidates.output);

		// Fail loud: a model we explicitly map MUST yield both an input and an output base SKU.
		// (A missing one means the usagetype scheme drifted and our allowlist no longer matches.)
		if (typeof prices.input !== 'number' || typeof prices.output !== 'number')
			throw new Error(
				`amazon collector: ${display} (${model_id}) matched but is missing a base ` +
					`${typeof prices.input !== 'number' ? 'input' : 'output'} on-demand token SKU - ` +
					'usagetype scheme drift. Refusing to guess.'
			);

		results.push({
			provider: PROVIDER,
			model_id,
			display_name: display,
			prices,
			unit: 'usd_per_mtok',
			source_url: PUBLIC_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: true,
			notes: `${display}. ${REGION}, on-demand (cross-region-global profile where AWS publishes one). From the AWS Bedrock Price List API.`,
		});
	}

	if (!results.length)
		throw new Error(
			'amazon collector: parsed the Bedrock price list but extracted zero Nova text rows - structure drift.'
		);
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('amazon collector failed:', e.message);
			process.exit(1);
		});
}
