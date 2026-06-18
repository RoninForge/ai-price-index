// Point-in-time pricing engine. Pure, zero-dependency, no runtime network: it reads the bundle that
// ships inside this package (lib/data.json, built by tools/build-npm.mjs). This is a faithful port of
// Goei's server engine (src/lib/server/pricing/{engine,bundle}.ts) so all three engines - the landing
// app, Goei, BudgetClaw - reproduce the SAME shared golden vectors (examples/pricing-vectors.json) to
// the cent. Half-open interval semantics: a rate applies for `from <= date && (to === null || date < to)`.
// Cache read = 0.1x input; cache write = 1.25x (5m) or 2x (1h).
import { readFileSync } from 'node:fs';

/** @type {import('../index.js').PriceBundle} */
export const bundle = JSON.parse(readFileSync(new URL('./data.json', import.meta.url), 'utf8'));

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_5M_MULT = 1.25;
export const CACHE_WRITE_1H_MULT = 2;

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

/** Point-in-time per-million input/output rates for (provider, model) on `date`, or null if the model
 *  is unresolved or the date is not covered. */
export function rateAt(provider, model, date) {
	const s = resolveSeries(provider, model);
	if (!s) return null;
	const inIv = intervalAt(s.variations.input, date);
	const outIv = intervalAt(s.variations.output, date);
	if (!inIv || !outIv) return null;
	return { inputPerM: inIv.price_usd, outputPerM: outIv.price_usd };
}

/** USD value of a token rollup at a point in time. Returns 0 with modelKnown=false when the model is
 *  unknown (so callers can count unpriced rows rather than silently mis-bill). */
export function usdForRollupRaw(tokens, provider, model, date) {
	const r = rateAt(provider, model, date);
	if (!r) return { usd: 0, modelKnown: false };
	const ip = r.inputPerM;
	const op = r.outputPerM;
	const usd =
		((tokens.input ?? 0) * ip +
			(tokens.output ?? 0) * op +
			(tokens.cache_read ?? 0) * (CACHE_READ_MULT * ip) +
			(tokens.cache_write_5m ?? 0) * (CACHE_WRITE_5M_MULT * ip) +
			(tokens.cache_write_1h ?? 0) * (CACHE_WRITE_1H_MULT * ip)) /
		1_000_000;
	return { usd, modelKnown: true };
}

/** USD value of a token rollup in integer cents (Math.round). Never throws; an unknown model yields
 *  { cents: 0, modelKnown: false }. */
export function usdForRollup(tokens, provider, model, date) {
	const { usd, modelKnown } = usdForRollupRaw(tokens, provider, model, date);
	return { cents: Math.round(usd * 100), modelKnown };
}
