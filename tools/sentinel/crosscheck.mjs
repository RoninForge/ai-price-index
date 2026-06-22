// tools/sentinel/crosscheck.mjs  (MIT)
// The correctness cross-check gate for the price-sentinel.
//
// This is the project's core differentiator made operational: before any NEW or CHANGED price is
// drafted as `verified`, run cheap automated checks. Confident items stay `verified` (a human barely
// needs to look). Suspicious items are downgraded to `inferred` + flagged `needs_review` with
// human-readable reasons, so a reviewer only spends time on the genuinely uncertain rows.
//
// This is the class of check that already caught a DeepSeek false-positive (a parse error that
// 2x'd a price) and the command-r7b transposition (input/output swapped).
//
// Pure + dependency-free. NO network calls happen here: the OpenRouter aggregator prices are
// passed in via ctx (built from the tripwire data run.mjs already fetched).

// ---------------------------------------------------------------------------
// thresholds (kept as named constants so the report copy and the code agree)
// ---------------------------------------------------------------------------

// A NEW/CHANGED price beyond this many usd_per_mtok is implausible for a per-token rate.
const IMPLAUSIBLY_HIGH_USD_PER_MTOK = 1000;
// A CHANGED price whose relative move on input OR output exceeds this is suspicious (parse error class).
const CHANGE_MAGNITUDE_REL = 0.3; // 30%
// OpenRouter is a RESELLER: its price is normally >= first-party. A first_party/openrouter ratio
// outside this band is suspicious (way under-reselling, or our number is multiples off).
const AGG_RATIO_LO = 0.5;
const AGG_RATIO_HI = 1.5;

// Variations we compare against the aggregator (OpenRouter only exposes prompt/completion).
const AGG_VARIATIONS = ['input', 'output'];

// ---------------------------------------------------------------------------
// OpenRouter lookup helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a model id into a comparison key so dash/dot/case/date-suffix differences between our
 * collectors and OpenRouter still match. e.g.
 *   "claude-3-5-haiku-20241022"  -> "claude-3-5-haiku"   (date suffix stripped)
 *   "anthropic/claude-3.5-haiku" -> "claude-3-5-haiku"   (vendor prefix + dot normalized)
 *   "Llama-4-Scout"              -> "llama-4-scout"
 * Returns "" for non-strings.
 */
export function normalizeModelKey(id) {
	if (typeof id !== 'string' || !id) return '';
	let s = id.toLowerCase();
	// drop a vendor/ prefix ("anthropic/claude-..." -> "claude-...")
	const slash = s.indexOf('/');
	if (slash >= 0) s = s.slice(slash + 1);
	// drop a ":variant" suffix (":free", ":thinking", ...)
	s = s.split(':')[0];
	// unify separators: dots/underscores/spaces -> hyphen
	s = s.replace(/[._\s]+/g, '-');
	// strip a trailing -YYYYMMDD or -YYYY-MM-DD date stamp (release-dated ids)
	s = s.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
	// collapse repeated hyphens, trim stray edge hyphens
	s = s.replace(/-+/g, '-').replace(/^-|-$/g, '');
	return s;
}

/**
 * Build an OpenRouter price lookup from tripwire candidates (already fetched by run.mjs - do NOT
 * re-fetch). Each OpenRouter candidate carries `source_id` ("anthropic/claude-3.5-haiku"),
 * `bare_id`, and reseller prices in usd_per_mtok. We index every id form under both its raw bare
 * form and its normalized key so the per-model lookup below is tolerant of id-shape drift.
 *
 * Returns { byKey: Map<normKey, {input,output}>, byProviderKey: Map<"provider/normKey", {input,output}> }.
 * Rows with no usable price (both undefined/null) are skipped.
 */
export function buildOpenRouterLookup(tripwireCandidates) {
	const byKey = new Map();
	const byProviderKey = new Map();
	for (const c of tripwireCandidates || []) {
		if (!c || c.source !== 'openrouter') continue;
		const input = numOrNull(c.reseller_input_usd_per_mtok);
		const output = numOrNull(c.reseller_output_usd_per_mtok);
		if (input === null && output === null) continue; // no price to cross-check against
		const prices = { input, output };
		const ids = new Set();
		if (typeof c.source_id === 'string') ids.add(c.source_id);
		if (typeof c.bare_id === 'string') ids.add(c.bare_id);
		for (const id of ids) {
			const key = normalizeModelKey(id);
			if (!key) continue;
			if (!byKey.has(key)) byKey.set(key, prices);
			if (c.provider) {
				const pk = `${c.provider}/${key}`;
				if (!byProviderKey.has(pk)) byProviderKey.set(pk, prices);
			}
		}
	}
	return { byKey, byProviderKey };
}

/**
 * Look up a model in the OpenRouter lookup by its provider + id + aliases. Provider-scoped match
 * first (avoids cross-vendor id collisions), then a global normalized-key match. Returns the
 * matched { input, output } prices or null.
 */
export function lookupOpenRouter(lookup, provider, modelId, aliases = []) {
	if (!lookup) return null;
	const tries = [modelId, ...(Array.isArray(aliases) ? aliases : [])];
	// provider-scoped first
	for (const id of tries) {
		const key = normalizeModelKey(id);
		if (!key) continue;
		const hit = lookup.byProviderKey && lookup.byProviderKey.get(`${provider}/${key}`);
		if (hit) return hit;
	}
	// then global (covers provider-slug mismatches between collector + tripwire mapping)
	for (const id of tries) {
		const key = normalizeModelKey(id);
		if (!key) continue;
		const hit = lookup.byKey && lookup.byKey.get(key);
		if (hit) return hit;
	}
	return null;
}

function numOrNull(v) {
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Round for human-readable reasons without dragging float noise into the copy. */
function r2(n) {
	return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

/**
 * Cross-check one drafted candidate before it is published as `verified`.
 *
 * candidate: {
 *   provider, model_id,
 *   prices: { input?, output?, cache_read?, ... },   // usd_per_mtok
 *   isNew: boolean,
 *   prior: { input?, output? } | null,               // current published prices, null for a NEW model
 *   aliases?: string[],                              // optional, helps the OpenRouter lookup
 * }
 * ctx: { openrouter }  // the lookup built by buildOpenRouterLookup (NO network here)
 *
 * Returns { verdict: 'verified' | 'needs_review', reasons: string[] }.
 * verdict === 'needs_review' if ANY check flags; else 'verified'.
 */
export function crossCheck(candidate, ctx = {}) {
	const reasons = [];
	const prices = (candidate && candidate.prices) || {};
	const isNew = !!(candidate && candidate.isNew);
	const prior = candidate && candidate.prior ? candidate.prior : null;

	// --- 1. STRUCTURAL sanity (transposition / implausibility) -----------------
	for (const [variation, price] of Object.entries(prices)) {
		if (typeof price !== 'number' || Number.isNaN(price)) continue;
		if (price < 0) reasons.push(`${variation} $${price} is negative`);
		if (price > IMPLAUSIBLY_HIGH_USD_PER_MTOK)
			reasons.push(`${variation} $${price}/MTok is implausibly high (> $${IMPLAUSIBLY_HIGH_USD_PER_MTOK})`);
	}
	const input = numOrNull(prices.input);
	const output = numOrNull(prices.output);
	const cacheRead = numOrNull(prices.cache_read);
	if (input !== null && output !== null && output < input) {
		reasons.push(`output $${output} < input $${input} (possible transposition)`);
	}
	if (cacheRead !== null && input !== null && cacheRead > input) {
		reasons.push(`cache_read $${cacheRead} > input $${input} (cache read should be cheaper than input)`);
	}

	// --- 2. CHANGE-MAGNITUDE (CHANGED only, prior exists) ----------------------
	if (!isNew && prior) {
		for (const variation of ['input', 'output']) {
			const to = numOrNull(prices[variation]);
			const from = numOrNull(prior[variation]);
			if (to === null || from === null) continue;
			if (from === 0) {
				if (to !== 0) reasons.push(`${variation} changed from $0 to $${to} - verify it's a real change not a parse error`);
				continue;
			}
			const rel = Math.abs(to - from) / Math.abs(from);
			if (rel > CHANGE_MAGNITUDE_REL) {
				const x = r2(to / from);
				reasons.push(
					`${variation} changed ${x}x ($${from} -> $${to}) - verify it's a real change not a parse error`
				);
			}
		}
	}

	// --- 3. AGGREGATOR cross-reference (best-effort, OpenRouter reseller) -------
	const orLookup = ctx && ctx.openrouter;
	const match = lookupOpenRouter(orLookup, candidate && candidate.provider, candidate && candidate.model_id, candidate && candidate.aliases);
	if (match) {
		for (const variation of AGG_VARIATIONS) {
			const fp = numOrNull(prices[variation]);
			const or = numOrNull(match[variation]);
			if (fp === null || or === null || or === 0) continue;
			const ratio = fp / or;
			if (ratio < AGG_RATIO_LO || ratio > AGG_RATIO_HI) {
				reasons.push(
					`${variation} $${r2(fp)} is ${r2(ratio)}x OpenRouter's $${r2(or)} - suspicious ` +
						`(reseller price should be >= first-party; expected ratio in [${AGG_RATIO_LO}, ${AGG_RATIO_HI}])`
				);
			}
		}
	} else if (isNew) {
		// A brand-new model with no aggregator corroboration deserves a human look.
		reasons.push('no independent corroboration (new model, no OpenRouter match)');
	} else {
		// CHANGED/UNCHANGED with no aggregator match: note it, but do NOT flip on this alone.
		reasons.push('no aggregator match');
	}

	// A bare "no aggregator match" note (CHANGED path) must not, by itself, force needs_review.
	const flagging = reasons.filter((r) => r !== 'no aggregator match');
	return { verdict: flagging.length ? 'needs_review' : 'verified', reasons };
}
