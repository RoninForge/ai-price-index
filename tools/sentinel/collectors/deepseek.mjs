// tools/sentinel/collectors/deepseek.mjs  (MIT)
// First-party DeepSeek price collector.
//
// AUTHORITATIVE source: https://api-docs.deepseek.com/quick_start/pricing/
//
// The TRAILING SLASH is load-bearing. DeepSeek's CDN (Tencent EdgeOne) holds a bad cache entry on the
// slash-less /quick_start/pricing: it answers 200 with an entirely DIFFERENT document ("Your First API
// Call"). A cache MISS on that URL redirects correctly, so the wrong page appears and disappears with
// the cache TTL, which is why this reads as an intermittent collector break. The slash-less form is the
// one DeepSeek declares rel=canonical, so we cite the slashed form knowingly: it is the URL that
// actually renders the price table for every client, and a citation nobody can verify is worthless.
// This Docusaurus page server-renders a single TRANSPOSED <table>: the models are the COLUMNS
// (deepseek-v4-flash, deepseek-v4-pro) and the attributes are the ROWS. There is no <thead>/<th>;
// every cell is a <td>. DeepSeek split every price row into OFF-PEAK / PEAK on 2026-08-16; each
// label cell now carries rowspan="2" and the PEAK values live on the FOLLOWING <tr>:
//
//   | MODEL                            | deepseek-v4-flash(1) | deepseek-v4-pro |
//   | ...                              | ...                  | ...             |
//   | PRICING | 1M INPUT TOKENS (CACHE HIT)  | OFF-PEAK | $0.007 | $0.022 |
//   |         |                              | PEAK     | $0.014 | $0.044 |
//   |         | 1M INPUT TOKENS (CACHE MISS) | OFF-PEAK | $0.22  | $0.66  |
//   |         |                              | PEAK     | $0.44  | $1.32  |
//   |         | 1M OUTPUT TOKENS             | OFF-PEAK | $0.66  | $1.98  |
//   |         |                              | PEAK     | $1.32  | $3.96  |
//
// We publish the OFF-PEAK rate as the standard input/output/cache_read. The page defines the split
// as "Off-peak rates are half of the peak rates", and off-peak covers 17 of 24 hours (peak is
// 01:00-04:00 and 06:00-10:00 UTC). OpenRouter resells deepseek-v4-pro at exactly the off-peak
// numbers, which is the cross-check that settles which rate the market treats as the list price.
// PEAK is parsed too, but only to ASSERT the page's own 2x invariant; it is never emitted, because
// the schema has no variation for a time-of-day rate.
//
// Label -> variation mapping (cache MISS is the standard/billed input rate; cache HIT is the
// discounted cached read):
//   1M INPUT TOKENS (CACHE MISS) -> input
//   1M INPUT TOKENS (CACHE HIT)  -> cache_read
//   1M OUTPUT TOKENS             -> output
// Prices are already per 1M tokens -> usd_per_mtok as-is.
//
// Model ids deepseek-v4-flash / deepseek-v4-pro ARE the canonical ids we track. The live API ids
// deepseek-chat (non-thinking) and deepseek-reasoner (thinking) BOTH route to deepseek-v4-flash and
// share its pricing, so they are carried as aliases of v4-flash (NOT of v4-pro). v4-pro is a
// separate, explicitly-selected model with no legacy alias.
//
// NOTE on the secondary page https://api-docs.deepseek.com/quick_start/pricing-details-usd : it lists
// LEGACY deprecated rows for deepseek-chat ($0.27 miss / $1.10 output) and deepseek-reasoner
// ($0.55 miss / $2.19 output). Those are the soon-to-be-retired (2026-07-24) 64K-context alias prices,
// NOT the current v4 prices, and must NOT be emitted. We parse the authoritative /pricing page only.
//
// Fail loud: if the table, the model columns, the three price rows, or the pinned price values are not
// found, THROW. Never emit a guessed number; a genuine future price change surfaces as a loud failure.

import { fetchText } from '../lib.mjs';

export const PROVIDER = 'deepseek';
const SOURCE_URL = 'https://api-docs.deepseek.com/quick_start/pricing/';

// Canonical model id (as it appears in the MODEL row of the authoritative table) -> aliases we carry.
// deepseek-chat + deepseek-reasoner both route to v4-flash and share its pricing (they deprecate
// 2026-07-24); v4-pro is explicitly selected and has no legacy alias. Unknown ids slugify -> NEW.
const ID_TO_ALIASES = {
	'deepseek-v4-flash': ['deepseek-chat', 'deepseek-reasoner'],
	'deepseek-v4-pro': undefined,
};

// Price-label (normalized lower-case, link/footnote-flattened) -> variation. Order-independent; we
// scan each row for whichever label it carries, so a re-ordered PRICING block is still parsed.
const LABEL_TO_VARIATION = [
	[/1m input tokens\s*\(cache miss\)/i, 'input'], //      billed (standard) input rate
	[/1m input tokens\s*\(cache hit\)/i, 'cache_read'], //  discounted cached read
	[/1m output tokens/i, 'output'], //                     output
];

// Correctness pins (USD per 1M tokens, OFF-PEAK, verified against the authoritative page 2026-08-17).
// If the live page disagrees beyond EPS, THROW so a real change surfaces for human review instead of
// silently flipping the dataset.
const PIN = {
	'deepseek-v4-flash': { input: 0.22, cache_read: 0.007, output: 0.66 },
	'deepseek-v4-pro': { input: 0.66, cache_read: 0.022, output: 1.98 },
};
const EPS = 1e-6;

// The page states "Off-peak rates are half of the peak rates". Parse PEAK and hold it to that, so a
// silent re-ordering of the two sub-rows cannot make us publish peak rates as standard.
const PEAK_MULTIPLIER = 2;
const PEAK_REL_TOL = 1e-9;
const OFF_PEAK_RE = /off-?peak/i;
const PEAK_RE = /^peak$/i;

function cellText(html) {
	return html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

function parsePrice(s) {
	const m = String(s).match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) ? n : null;
}

function slugify(name) {
	return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Resolve a row's price label to exactly one variation by scanning all its cells, or null. */
function rowVariation(cells) {
	for (const cell of cells) {
		for (const [re, variation] of LABEL_TO_VARIATION) {
			if (re.test(cell)) return variation;
		}
	}
	return null;
}

/**
 * Collect DeepSeek model prices from the authoritative (transposed) pricing table.
 * Returns array of { provider, model_id, display_name, aliases?, prices:{input,output,cache_read},
 *                    unit, source_url, source_kind, confidence, known_mapping }. Fails loud on drift.
 */
export async function collect() {
	const html = await fetchText(SOURCE_URL);

	// Check we were served the pricing page before blaming its table: a wrong document otherwise
	// reports as "the table shape changed" and sends the reader hunting for a redesign that never was.
	const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
	if (!/pricing/i.test(title))
		throw new Error(
			`deepseek collector: served a different document (title "${title}") instead of the pricing ` +
				`page. Usually a stale CDN cache entry on ${SOURCE_URL}, not a DeepSeek change.`
		);

	const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
	if (!tableMatch) throw new Error('deepseek collector: no <table> on the authoritative pricing page - structure drift.');
	const table = tableMatch[0];

	const rows = [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
		[...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cellText(m[1]))
	);
	if (!rows.length) throw new Error('deepseek collector: pricing table has no rows - structure drift.');

	// 1) Locate the MODEL row (this table is transposed: models are the columns). The model ids are the
	//    cells in that row that look like a DeepSeek model id. Order defines the price-column order.
	let modelIds = null;
	for (const cells of rows) {
		if (!cells.length) continue;
		if (cells[0].toLowerCase() !== 'model') continue;
		const ids = cells
			.slice(1)
			.map((c) => c.replace(/\(\s*\d+\s*\)/g, '').trim()) // drop trailing <sup>(n)</sup> footnotes
			.filter((c) => /^deepseek[-\w.]+$/i.test(c));
		if (ids.length) {
			modelIds = ids;
			break;
		}
	}
	if (!modelIds || !modelIds.length)
		throw new Error(
			'deepseek collector: MODEL row with deepseek-* column ids not found. Expected a transposed ' +
				'table "MODEL | deepseek-v4-flash | deepseek-v4-pro | ...". Refusing to guess.'
		);

	// 2) Walk the price rows. Each labelled row is the OFF-PEAK half and the row straight after it is
	//    the PEAK half. The trailing N cells (N = #models) are the per-model values in column order;
	//    leading label cells ("PRICING", the variation, "OFF-PEAK") carry no "$" so they drop out.
	const priceCells = (cells, variation, half) => {
		const vals = cells.map(parsePrice).filter((v) => v !== null);
		if (vals.length !== modelIds.length)
			throw new Error(
				`deepseek collector: "${variation}" ${half} row has ${vals.length} price cell(s) but there are ` +
					`${modelIds.length} model column(s) [${modelIds.join(', ')}]. Row: [${cells.join(' | ')}]. Refusing to guess.`
			);
		return vals;
	};

	const prices = Object.fromEntries(modelIds.map((id) => [id, {}]));
	const seen = new Set();
	for (let i = 0; i < rows.length; i++) {
		const cells = rows[i];
		const variation = rowVariation(cells);
		if (!variation) continue;
		if (seen.has(variation))
			throw new Error(`deepseek collector: price row for "${variation}" appears twice - structure drift, refusing to guess.`);

		if (!cells.some((c) => OFF_PEAK_RE.test(c)))
			throw new Error(
				`deepseek collector: "${variation}" row carries no OFF-PEAK marker. Row: [${cells.join(' | ')}]. ` +
					'The peak/off-peak split changed shape - refusing to guess which half is the standard rate.'
			);

		const offPeak = priceCells(cells, variation, 'off-peak');
		const next = rows[i + 1];
		if (!next || !next.some((c) => PEAK_RE.test(c)))
			throw new Error(
				`deepseek collector: "${variation}" off-peak row is not followed by a PEAK row. ` +
					`Next row: [${(next || []).join(' | ')}]. Refusing to guess.`
			);
		const peak = priceCells(next, variation, 'peak');

		peak.forEach((p, j) => {
			const want = offPeak[j] * PEAK_MULTIPLIER;
			if (Math.abs(p - want) > Math.max(EPS, Math.abs(want) * PEAK_REL_TOL))
				throw new Error(
					`deepseek collector: ${modelIds[j]}.${variation} peak ${p} is not ${PEAK_MULTIPLIER}x off-peak ` +
						`${offPeak[j]} (expected ${want}). The page's stated "off-peak is half of peak" rule no longer ` +
						'holds, so which half is the standard rate is no longer decidable - human review required.'
				);
		});

		seen.add(variation);
		modelIds.forEach((id, j) => {
			prices[id][variation] = offPeak[j];
		});
	}

	for (const need of ['input', 'cache_read', 'output']) {
		if (!seen.has(need))
			throw new Error(
				`deepseek collector: required "${need}" price row not found. Expected 1M INPUT TOKENS ` +
					'(CACHE HIT), 1M INPUT TOKENS (CACHE MISS), 1M OUTPUT TOKENS. Refusing to guess.'
			);
	}

	// 3) Correctness pins. THROW (do not emit) if the live page differs from the verified values, so a
	//    real change is escalated to a human rather than silently flipping the dataset.
	for (const [id, want] of Object.entries(PIN)) {
		const got = prices[id];
		if (!got) throw new Error(`deepseek collector: expected canonical model "${id}" missing from the live page - structure drift.`);
		for (const [variation, expected] of Object.entries(want)) {
			const actual = got[variation];
			if (typeof actual !== 'number' || Math.abs(actual - expected) > EPS)
				throw new Error(
					`deepseek collector: PIN MISMATCH for ${id}.${variation}: live page says ${actual}, ` +
						`pinned ${expected}. The authoritative page may have genuinely changed - human review required, not auto-emit.`
				);
		}
	}

	// 4) Build results in MODEL-row order.
	const results = modelIds.map((id) => {
		const known = id in ID_TO_ALIASES;
		const aliases = ID_TO_ALIASES[id];
		return {
			provider: PROVIDER,
			model_id: known ? id : slugify(id),
			display_name: id,
			aliases: aliases && aliases.length ? aliases : undefined,
			prices: prices[id],
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: known,
		};
	});

	if (!results.length)
		throw new Error('deepseek collector: located the table but extracted zero DeepSeek models - structure drift.');
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('deepseek collector failed:', e.message);
			process.exit(1);
		});
}
