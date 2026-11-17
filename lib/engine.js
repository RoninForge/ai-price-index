// Point-in-time pricing engine. Pure, zero-dependency, no runtime network: it reads the bundle that
// ships inside this package (lib/data.json, built by tools/build-npm.mjs). This is a faithful port of
// Goei's server engine (src/lib/server/pricing/{engine,bundle}.ts) so all three engines - the landing
// app, Goei, BudgetClaw - reproduce the SAME shared golden vectors (examples/pricing-vectors.json) to
// the cent. Half-open interval semantics: a rate applies for `from <= date && (to === null || date < to)`.
// Cache read = the recorded cache_read rate, falling back to 0.1x input for a model with no cache_read
// series (same rule as BudgetClaw's cacheReadAt); cache write = 1.25x (5m) or 2x (1h).
//
// Prompt-length tiers (tier2_* variations, e.g. Claude Haiku 5.5 "for prompts over 100,000 tokens")
// bill a whole REQUEST at the tier2 rates once its prompt crosses the provider's threshold. Only
// usdForRequest/usdForRequestRaw apply them; usdForRollup prices a sum of requests at the base tier.
import { readFileSync } from 'node:fs';

/** @type {import('../index.js').PriceBundle} */
export const bundle = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'));

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;

// Prompt size above which a provider bills a request at its tier2 rates. Only thresholds the provider
// publishes are listed; a tiered model from an unlisted provider prices at its base tier.
export const PROMPT_TIER_THRESHOLDS = Object.freeze({ anthropic: 100_000 });

// "provider/model" (and "provider/alias") -> series. Canonical model keys win over alias keys on a
// collision (canonical inserted last and overwrites), matching bundle.ts.
const SERIES_BY_KEY = new Map();
for (const s of bundle.series) {
	for (const alias of s.aliases ?? []) SERIES_BY_KEY.set(`${s.provider}/${alias}`, s);
}
for (const s of bundle.series) SERIES_BY_KEY.set(`${s.provider}/${s.model}`, s);

/** Exact-or-alias lookup for one provider/model id. No tolerance here (the engine layers that on). */
export function seriesFor(provider, model) {
	return SERIES_BY_KEY.get(`${provider}/${model}`) ?? null;
}

/** All series for a provider (used by the prefix-tolerance fallback). */
export function seriesForProvider(provider) {
	return bundle.series.filter((s) => s.provider === provider);
}

/** Pick the interval covering `date` with half-open semantics. ISO YYYY-MM-DD sorts lexicographically,
 *  so plain string comparison is exact. */
export function intervalAt(intervals, date) {
	for (const iv of intervals) {
		if (iv.from <= date && (iv.to === null || date < iv.to)) return iv;
	}
	return null;
}

/** Resolve a model id to its series with claude-cost-style tolerance: exact/alias, then strip a
 *  trailing display suffix like "[1m]", then prefix tolerance against canonical ids + aliases within
 *  the same provider. Mirrors Goei's resolveSeries exactly. */
export function resolveSeries(provider, model) {
	const direct = seriesFor(provider, model);
	if (direct) return direct;

	const base = model.replace('[1m]', '').trim();
	if (base !== model) {
		const viaBase = seriesFor(provider, base);
		if (viaBase) return viaBase;
	}

	for (const s of seriesForProvider(provider)) {
		const ids = [s.model, ...(s.aliases ?? [])];
		for (const id of ids) {
			if (base.startsWith(id) || id.startsWith(base)) return s;
		}
	}
	return null;
}

function ratesFrom(variations, prefix, date) {
	const inIv = intervalAt(variations[`${prefix}input`] ?? [], date);
	const outIv = intervalAt(variations[`${prefix}output`] ?? [], date);
	if (!inIv || !outIv) return null;
	const cr = variations[`${prefix}cache_read`];
	const crIv = cr ? intervalAt(cr, date) : null;
	return {
		inputPerM: inIv.price_usd,
		outputPerM: outIv.price_usd,
		cacheReadPerM: crIv ? crIv.price_usd : CACHE_READ_MULT * inIv.price_usd,
	};
}

/** Point-in-time per-million input/output rates for (provider, model) on `date`, or null if the model
 *  is unresolved or the date is not covered. */
export function rateAt(provider, model, date) {
	const s = resolveSeries(provider, model);
	return s ? ratesFrom(s.variations, '', date) : null;
}

/** The prompt-length tier's rates for (provider, model) on `date`, or null when the model has no tier
 *  in effect then. Same shape as rateAt. */
export function tier2RateAt(provider, model, date) {
	const s = resolveSeries(provider, model);
	return s ? ratesFrom(s.variations, 'tier2_', date) : null;
}

/** A request's prompt size as providers count it for prompt-length tiers: fresh input plus cache reads
 *  and cache writes. Output is not part of the prompt. */
export function promptTokens(tokens) {
	return (
		(tokens.input ?? 0) + (tokens.cache_read ?? 0) + (tokens.cache_write_5m ?? 0) + (tokens.cache_write_1h ?? 0)
	);
}

function usdAt(tokens, r) {
	const ip = r.inputPerM;
	return (
		((tokens.input ?? 0) * ip +
			(tokens.output ?? 0) * r.outputPerM +
			(tokens.cache_read ?? 0) * r.cacheReadPerM +
			(tokens.cache_write_5m ?? 0) * (CACHE_WRITE_5M_MULT * ip) +
			(tokens.cache_write_1h ?? 0) * (CACHE_WRITE_1H_MULT * ip)) /
		1_000_000
	);
}

/** USD value of a token rollup at a point in time, at the base tier. Returns 0 with modelKnown=false
 *  when the model is unknown (so callers can count unpriced rows rather than silently mis-bill). A
 *  rollup cannot tell which of its requests crossed a prompt-length threshold, so for a tiered model
 *  this is a lower bound; price each request with usdForRequestRaw when the per-request split exists. */
export function usdForRollupRaw(tokens, provider, model, date) {
	const r = rateAt(provider, model, date);
	if (!r) return { usd: 0, modelKnown: false };
	return { usd: usdAt(tokens, r), modelKnown: true };
}

/** USD value of ONE request at a point in time. A request whose prompt exceeds the provider's
 *  PROMPT_TIER_THRESHOLDS entry on a model with a prompt-length tier is billed entirely at the tier2
 *  rates (tier2: true). Unknown model -> { usd: 0, modelKnown: false, tier2: false }. */
export function usdForRequestRaw(tokens, provider, model, date) {
	const s = resolveSeries(provider, model);
	const base = s ? ratesFrom(s.variations, '', date) : null;
	if (!base) return { usd: 0, modelKnown: false, tier2: false };
	const threshold = PROMPT_TIER_THRESHOLDS[s.provider];
	const t2 = threshold !== undefined && promptTokens(tokens) > threshold ? ratesFrom(s.variations, 'tier2_', date) : null;
	return { usd: usdAt(tokens, t2 ?? base), modelKnown: true, tier2: t2 !== null };
}

/** usdForRequestRaw in integer cents (Math.round). Never throws. */
export function usdForRequest(tokens, provider, model, date) {
	const { usd, modelKnown, tier2 } = usdForRequestRaw(tokens, provider, model, date);
	return { cents: Math.round(usd * 100), modelKnown, tier2 };
}

/** USD value of a token rollup in integer cents (Math.round). Never throws; an unknown model yields
 *  { cents: 0, modelKnown: false }. */
export function usdForRollup(tokens, provider, model, date) {
	const { usd, modelKnown } = usdForRollupRaw(tokens, provider, model, date);
	return { cents: Math.round(usd * 100), modelKnown };
}
