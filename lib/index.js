// ai-price-index - the public API.
//
// Open, dated, first-party-sourced AI model API prices over time. This package answers "what did
// this model cost on this date" with the verifiable source attached, not just today's number.
//
//   import { current, priceOn, models } from 'ai-price-index';
//   current('claude-opus-4-8');            // today's input/output rate + provenance
//   priceOn('gpt-4', '2024-01-01');        // the rate that was in effect on that date
//
// Data is bundled inline (no runtime network). Data CC BY 4.0, tooling MIT. See README for attribution.
import {
	bundle,
	resolveSeries,
	seriesFor,
	intervalAt,
	rateAt,
	usdForRollup,
	usdForRollupRaw,
	CACHE_READ_MULT,
	CACHE_WRITE_5M_MULT,
	CACHE_WRITE_1H_MULT
} from './engine.js';

export {
	bundle,
	rateAt,
	usdForRollup,
	usdForRollupRaw,
	CACHE_READ_MULT,
	CACHE_WRITE_5M_MULT,
	CACHE_WRITE_1H_MULT
};

/** Dataset metadata (version, dataModified date, license, DOI, source provenance). */
export const meta = {
	schemaVersion: bundle.schemaVersion,
	dataModified: bundle.dataModified,
	license: bundle.license,
	doi: bundle.doi,
	attribution: bundle.attribution,
	source: bundle.source
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Sorted list of provider slugs present in the dataset. */
export function providers() {
	return [...new Set(bundle.series.map((s) => s.provider))].sort();
}

/** Every model series as { provider, model, aliases }. */
export function models() {
	return bundle.series
		.map((s) => ({ provider: s.provider, model: s.model, aliases: s.aliases ?? [] }))
		.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`));
}

/** All series whose canonical id or an alias EXACTLY matches `model`, across every provider. Used to
 *  detect (and report) the rare case where the same bare id exists under more than one provider. */
export function candidates(model) {
	return providers()
		.map((p) => seriesFor(p, model))
		.filter(Boolean);
}

/**
 * Resolve a (possibly provider-less, possibly aliased) model id to its canonical series.
 * - With `opts.provider`, resolves within that provider (exact/alias/[1m]/prefix tolerance).
 * - Without a provider, prefers a unique exact/alias match across providers; throws if a bare id is
 *   ambiguous (pass `{ provider }`); falls back to tolerance only when no exact match exists anywhere.
 * Returns { provider, model, aliases, series } or null.
 */
export function resolve(model, opts = {}) {
	if (typeof model !== 'string' || !model.trim()) return null;
	const wrap = (s) => ({ provider: s.provider, model: s.model, aliases: s.aliases ?? [], series: s });

	if (opts.provider) {
		const s = resolveSeries(opts.provider, model);
		return s ? wrap(s) : null;
	}

	const exact = candidates(model);
	if (exact.length === 1) return wrap(exact[0]);
	if (exact.length > 1) {
		const where = exact.map((s) => `${s.provider}/${s.model}`).join(', ');
		throw new Error(
			`"${model}" is ambiguous across providers (${where}). Pass { provider } to disambiguate.`
		);
	}

	// No exact match anywhere: allow per-provider tolerance ([1m] strip, prefix), first hit wins.
	for (const p of providers()) {
		const s = resolveSeries(p, model);
		if (s) return wrap(s);
	}
	return null;
}

function intervalView(iv) {
	if (!iv) return null;
	return {
		price_usd: iv.price_usd,
		unit: iv.unit,
		from: iv.from,
		to: iv.to,
		last_validated: iv.last_validated ?? null,
		confidence: iv.confidence ?? null,
		source: iv.src ?? null
	};
}

/**
 * The input + output rate for `model` on `date` (default today), with provenance.
 * Returns null when the model cannot be resolved. When the model resolves but `date` predates its
 * coverage, `covered` is false and the rate fields are null.
 *
 *   priceOn('claude-opus-4-8')                 // today
 *   priceOn('gpt-4', '2024-01-01')             // a past date
 *   priceOn('command-r', { provider: 'cohere' })
 *   priceOn('gpt-4', '2024-01-01', { provider: 'openai' })
 */
export function priceOn(model, date, opts) {
	// Flexible args: (model), (model, date), (model, opts), (model, date, opts).
	if (date && typeof date === 'object') {
		opts = date;
		date = undefined;
	}
	opts = opts ?? {};
	const on = date ?? todayISO();
	if (!isISODate(on)) throw new Error(`date must be YYYY-MM-DD, got "${on}"`);

	const r = resolve(model, opts);
	if (!r) return null;

	const input = intervalView(intervalAt(r.series.variations.input ?? [], on));
	const output = intervalView(intervalAt(r.series.variations.output ?? [], on));
	return {
		query: model,
		provider: r.provider,
		model: r.model,
		aliases: r.aliases,
		date: on,
		covered: Boolean(input || output),
		input,
		output
	};
}

/** Today's rate for `model` (sugar for priceOn(model) with no date). */
export function current(model, opts) {
	return priceOn(model, todayISO(), opts ?? {});
}

/** Convenience: per-million input/output numbers for `model` on `date`, auto-resolving the provider.
 *  Returns { provider, model, date, inputPerM, outputPerM } or null. */
export function rate(model, date, opts) {
	if (date && typeof date === 'object') {
		opts = date;
		date = undefined;
	}
	const r = resolve(model, opts ?? {});
	if (!r) return null;
	const on = date ?? todayISO();
	const at = rateAt(r.provider, r.model, on);
	if (!at) return null;
	return { provider: r.provider, model: r.model, date: on, ...at };
}

export default {
	meta,
	bundle,
	providers,
	models,
	candidates,
	resolve,
	priceOn,
	current,
	rate,
	rateAt,
	usdForRollup,
	usdForRollupRaw
};
