// tools/sentinel/collectors/openai.mjs  (MIT)
// First-party OpenAI (GPT / o-series) price collector. KEYLESS.
//
// Source: https://developers.openai.com/api/docs/pricing  - an Astro page with hydrated islands.
// IMPORTANT (verified 2026-06-20): a plain fetch is rejected with HTTP 403. A browser-like
// User-Agent gets HTTP 200 (~587KB), so this collector sends Chrome-ish headers (UA + Accept +
// Accept-Language) and retries, mirroring collectors/google.mjs and collectors/xai.mjs.
//
// WHY TWO SOURCES ON ONE PAGE (read before "fixing"). The pricing tables live in
// <astro-island component-export="TextTokenPricingTables"> elements, one per billing tier
// (standard / batch / flex / fast). Each island carries the SAME prices twice, in two different
// shapes, and neither shape alone is sufficient:
//
//   1. A server-rendered <table> - LABELLED but PARTIAL. It covers only the newest models
//      (9 as of 2026-07-31) and is the ONLY place the long-context tier appears. Its header is
//      self-describing: a group row (Short context | Long context) over a column row
//      (Model | Input | Cached input | Cache writes | Output | ...repeated per group).
//   2. The island's `props.rows` payload - COMPLETE but POSITIONAL. It carries every model on the
//      tier (36 as of 2026-07-31) as bare value tuples with no column labels, short context only.
//
// So: the rendered table is authoritative where it overlaps (it has labels AND long context), and
// the payload supplies the tail of older models. Where both describe a model, the payload's values
// are CROSS-CHECKED against the table's short-context values and a mismatch throws.
//
// WHY NOT THE PAYLOAD ALONE (this cost us real coverage). This collector used to parse only the
// payload, with a regex that hardcoded exactly three price slots per row. OpenAI then added a
// "Cache writes" column, so the newest models' rows grew to four slots and stopped matching the
// regex entirely. The collector kept reporting success while silently emitting 13 of the 22 models it
// tracked - gpt-5.4, gpt-5.4-mini, gpt-5.4-nano, gpt-5.4-pro, gpt-5.5 and gpt-5.5-pro all vanished
// from its output, and the whole gpt-5.6 family was never seen. Nothing caught it, because the PIN
// model (gpt-4o) is a three-slot row and still passed. Two structural defences now exist: the column
// layout is read from the table's own HEADER rather than assumed by position, and COVERAGE is
// asserted (see assertCoverage) so "tracked but not emitted" fails loudly instead of passing quietly.
//
// TIERS - WE TAKE THE STANDARD TIER ONLY, and we now select it EXPLICITLY by the island's
// `props.tier === 'standard'` rather than by "first tuple in document order wins". The other tiers
// (batch/flex ~50% off, fast with a surcharge) are never parsed.
//
// Mapping: page display names map 1:1 to our canonical ids for the tracked set (the bare id, or the
// bare id followed by a " (<...context length)" suffix which we strip). A ">" context suffix would be
// a long-context ROW rather than a column group; it is rejected so it can never be mistaken for the
// standard rate. gpt-4 and gpt-4-turbo are tracked by us but the page only carries DATED snapshots of
// them (gpt-4-0613, gpt-4-turbo-2024-04-09, ...), never the bare canonical id, so they are OMITTED
// here (we do not invent a snapshot->bare mapping); see PAGE_ABSENT.
//
// Contract (same as the other collectors): an array of
//   { provider:"openai", model_id, display_name, prices:{ input, output, cache_read?, cache_write?,
//     tier2_input?, tier2_output?, tier2_cache_read?, tier2_cache_write? } (usd_per_mtok),
//     unit:"usd_per_mtok", source_url, source_kind:"provider_live", confidence:"verified",
//     known_mapping }
// plus an out-of-band notice channel, getNotices(), for models on the page that we do not track.
//
// Fail loud: if the standard island is not found, if a column header is not one we recognise, if a
// payload row has an unknown slot count, if the table and payload disagree, if a tracked model goes
// missing, or if the post-build PIN (gpt-4o = $2.5 in / $10 out) disagrees, THROW. Never emit a
// guessed number.
//
// Zero new npm deps; Node ESM; built-in global fetch + AbortController. lib.fetchText sends neither a
// browser UA nor Accept-Language (the page 403s / could locale-negotiate), so this collector owns a
// small self-contained fetch that matches lib's timeout conventions.

export const PROVIDER = 'openai';
const SOURCE_URL = 'https://developers.openai.com/api/docs/pricing';

// Browser-like headers: the page 403s a non-browser UA, 200s a Chrome UA. Accept-Language pins English
// in case the docs ever locale-negotiate (ai.google.dev did).
const BROWSER_UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20000; // page is ~587KB; give it a touch more than lib's 15s
const MAX_FETCH_ATTEMPTS = 4; // tolerate transient 403/socket-close + locale misses

// The exact set of canonical model ids we track for OpenAI (mirrors data/ai-price-index index/current).
// Page names map to these either directly or after stripping a " (<...context length)" suffix.
const TRACKED = new Set([
	'gpt-4.1',
	'gpt-4o',
	'gpt-4o-mini',
	'gpt-5',
	'gpt-5.1',
	'gpt-5.2',
	'gpt-5.2-pro',
	'gpt-5.4',
	'gpt-5.4-mini',
	'gpt-5.4-nano',
	'gpt-5.4-pro',
	'gpt-5.5',
	'gpt-5.5-pro',
	'gpt-5.6-luna',
	'gpt-5.6-sol',
	'gpt-5.6-terra',
	'o1',
	'o1-mini',
	'o1-pro',
	'o3',
	'o3-deep-research',
	'o3-mini',
	'o3-pro',
	'o4-mini',
	'o4-mini-deep-research',
	// gpt-4 + gpt-4-turbo are tracked but the page only has dated snapshots; see PAGE_ABSENT.
]);

// Tracked ids that are legitimately NOT on this page, with the reason. assertCoverage exempts these,
// so everything else in TRACKED must be found or the run fails. Keep this list short and dated: an
// entry here is a standing claim that a model we publish prices for cannot be re-verified from the
// vendor's own pricing page, which is exactly the kind of thing that should require a human to type.
const PAGE_ABSENT = new Map([
	['gpt-4', 'page carries only dated snapshots (gpt-4-0613); we do not map snapshot -> bare id'],
	['gpt-4-turbo', 'page carries only dated snapshots (gpt-4-turbo-2024-04-09)'],
	['o1-mini', 'off the pricing page as of 2026-07-31; retirement not yet confirmed'],
	['o3-deep-research', 'off the pricing page as of 2026-07-31; retirement not yet confirmed'],
	['o4-mini-deep-research', 'off the pricing page as of 2026-07-31; retirement not yet confirmed'],
]);

// Models on the standard page we deliberately do not track, with the reason. Anything on the page that
// is in neither TRACKED nor here is reported through getNotices() as a candidate, which is how a new
// OpenAI model surfaces. Before this list existed a new model was simply invisible: the whole gpt-5.6
// family (sol/terra/luna) shipped and sat unnoticed because an unknown name was silently dropped.
const KNOWN_UNTRACKED = new Map([
	['babbage-002', 'legacy completions model'],
	['davinci-002', 'legacy completions model'],
	['gpt-3.5-turbo', 'legacy'],
	['gpt-3.5-turbo-0125', 'legacy dated snapshot'],
	['gpt-3.5-turbo-1106', 'legacy dated snapshot'],
	['gpt-3.5-turbo-instruct', 'legacy completions model'],
	['gpt-4-0613', 'dated snapshot of a tracked family'],
	['gpt-4-turbo-2024-04-09', 'dated snapshot of a tracked family'],
	['gpt-4o-2024-05-13', 'dated snapshot of a tracked family'],
	['gpt-4.1-mini', 'current model, not yet in our tracked set'],
	['gpt-4.1-nano', 'current model, not yet in our tracked set'],
	['gpt-5-mini', 'current model, not yet in our tracked set'],
	['gpt-5-nano', 'current model, not yet in our tracked set'],
	['gpt-5-pro', 'current model, not yet in our tracked set'],
]);

// PIN: gpt-4o is present on the page AND in current.json and is rock-stable. If the standard tuple ever
// stops resolving to $2.5 in / $10 out, the parse drifted or OpenAI changed it - either way, escalate.
const PIN_ID = 'gpt-4o';
const PIN_EXPECT = { input: 2.5, output: 10 };

// Column header label -> our variation name, per context-column GROUP. A label we do not recognise
// throws: that is the whole point of reading the header instead of counting columns.
const GROUP_COLUMNS = {
	'short context': {
		input: 'input',
		'cached input': 'cache_read',
		'cache writes': 'cache_write',
		output: 'output',
	},
	'long context': {
		input: 'tier2_input',
		'cached input': 'tier2_cache_read',
		'cache writes': 'tier2_cache_write',
		output: 'tier2_output',
	},
};

// Positional layouts for the island's props.rows payload, which carries no labels. Keyed by slot
// count, and every layout is CROSS-CHECKED against the rendered table wherever the two overlap, so a
// silently reordered payload cannot slip through. An unknown slot count throws.
const PAYLOAD_LAYOUTS = new Map([
	[4, ['input', 'cache_read', 'cache_write', 'output']],
	[3, ['input', 'cache_read', 'output']],
]);

// Out-of-band findings for the caller (run.mjs), reset at the start of each collect().
let notices = [];

/** Models seen on the page that we neither track nor knowingly ignore. Read after collect(). */
export function getNotices() {
	return notices.slice();
}

function nearly(a, b) {
	return typeof a === 'number' && Math.abs(a - b) <= 1e-6;
}

function unescape(html) {
	return html
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

/** True when a fetched body carries the tier islands we anchor the parse on. */
function looksLikePricePayload(html) {
	return html.includes('component-export="TextTokenPricingTables"');
}

/**
 * Fetch the pricing page with browser headers + a retry loop. The page 403s a non-browser UA and is
 * large; both a transient 403 and a mid-stream socket close are cheap to absorb with retries. Throws
 * only if every attempt fails to yield a body that contains the pricing islands.
 */
async function fetchPricingHtml() {
	let lastErr = null;
	for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const res = await fetch(SOURCE_URL, {
				headers: {
					'user-agent': BROWSER_UA,
					'accept-language': 'en-US,en;q=0.9',
					accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
				},
				signal: controller.signal,
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const html = await res.text();
			if (looksLikePricePayload(html)) return html;
			lastErr = new Error('body had no TextTokenPricingTables island');
		} catch (e) {
			lastErr = e;
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error(
		`openai collector: could not fetch a usable pricing page after ${MAX_FETCH_ATTEMPTS} attempts ` +
			`(last: ${lastErr ? lastErr.message : 'unknown'}). Refusing to guess.`
	);
}

/**
 * Locate the STANDARD-tier pricing island and return its parsed props plus its inner HTML.
 *
 * Selection is explicit (props.tier === 'standard'), not positional: the page renders four sibling
 * islands (standard / batch / flex / fast) carrying the same models at different rates, and picking
 * the wrong one would silently publish a discounted or surcharged rate as the list price.
 */
function standardIsland(rawHtml) {
	const tagRe = /<astro-island\b[^>]*?component-export="TextTokenPricingTables"[^>]*?>/g;
	const seen = [];
	let m;
	while ((m = tagRe.exec(rawHtml))) {
		const tag = m[0];
		const propsAttr = /\sprops="([^"]*)"/.exec(tag);
		if (!propsAttr) continue;
		let props;
		try {
			props = JSON.parse(unescape(propsAttr[1]));
		} catch (e) {
			throw new Error(`openai collector: island props are not valid JSON (${e.message}). Refusing to guess.`);
		}
		const tier = Array.isArray(props.tier) ? props.tier[1] : null;
		seen.push(tier);
		if (tier !== 'standard') continue;

		// Inner HTML runs to the next sibling island (or end of document). The rendered table sits well
		// before it, so this slice cannot pick up another tier's rows.
		const start = m.index + tag.length;
		const nextIsland = rawHtml.indexOf('<astro-island', start);
		return { props, inner: rawHtml.slice(start, nextIsland === -1 ? undefined : nextIsland) };
	}
	throw new Error(
		`openai collector: no standard-tier TextTokenPricingTables island found (tiers seen: ` +
			`${seen.length ? seen.join(', ') : 'none'}). The page structure drifted; refusing to guess.`
	);
}

/** Strip tags from a table cell and normalise its text. */
function cellText(html) {
	return unescape(html.replace(/<[^>]+>/g, ' '))
		.replace(/\s+/g, ' ')
		.trim();
}

/** Parse one rendered price cell: "$5.00" -> 5, "$0.075" -> 0.075, "-" / "" -> null. */
function parseCell(text) {
	const s = text.replace(/[$,]/g, '').trim();
	if (s === '' || s === '-') return null;
	const n = parseFloat(s);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse a single price slot from the payload (one of: a number like `2.5`, `null`, `"-"`, or `""`).
 * Returns a finite non-negative number, or null for any "no price" form.
 */
function parseSlot(raw) {
	if (raw == null) return null;
	let s = String(raw).trim();
	if (s === 'null') return null;
	// strip surrounding quotes if present ("-", "")
	if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
	if (s === '' || s === '-') return null;
	const n = parseFloat(s);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Build the column index -> variation map from the table's OWN header rows.
 *
 * `groupRow` is the optional grouping row (["", "Short context", "Long context"]); `columnRow` is the
 * label row (["Model", "Input", "Cached input", "Cache writes", "Output", ...repeated per group]).
 * With no group row every column is short context. An unrecognised group or column label throws,
 * which is how a newly-added column announces itself instead of shifting every value one place left.
 */
function columnMap(groupRow, columnRow) {
	const labels = columnRow.slice(1); // drop the "Model" column
	const groups = (groupRow || []).map((c) => c.trim()).filter(Boolean);
	const effective = groups.length ? groups : ['Short context'];

	if (!labels.length || labels.length % effective.length !== 0)
		throw new Error(
			`openai collector: ${labels.length} price columns do not divide evenly across ` +
				`${effective.length} context group(s) [${effective.join(', ')}]. Header drifted; refusing to guess.`
		);

	const per = labels.length / effective.length;
	const out = [];
	for (let g = 0; g < effective.length; g++) {
		const groupKey = effective[g].toLowerCase();
		const columns = GROUP_COLUMNS[groupKey];
		if (!columns)
			throw new Error(
				`openai collector: unknown context group "${effective[g]}" in the pricing table header. ` +
					`Known groups: ${Object.keys(GROUP_COLUMNS).join(', ')}. Refusing to guess.`
			);
		for (let j = 0; j < per; j++) {
			const label = labels[g * per + j].toLowerCase();
			const variation = columns[label];
			if (!variation)
				throw new Error(
					`openai collector: unknown price column "${labels[g * per + j]}" under "${effective[g]}". ` +
						`Known columns: ${Object.keys(columns).join(', ')}. OpenAI added or renamed a column; ` +
						`map it deliberately rather than letting it shift the others.`
				);
			out.push(variation);
		}
	}
	return out;
}

/**
 * Parse the server-rendered table inside the standard island.
 * Returns Map(rawDisplayName -> { variation: price }). Empty map if no table is rendered.
 */
function parseRenderedTable(inner) {
	const tableMatch = /<table[\s\S]*?<\/table>/.exec(inner);
	if (!tableMatch) return new Map();

	const rows = [];
	const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
	let r;
	while ((r = rowRe.exec(tableMatch[0]))) {
		const cells = [];
		const cellRe = /<(th|td)[^>]*>([\s\S]*?)<\/\1>/g;
		let c;
		let isHeader = false;
		while ((c = cellRe.exec(r[1]))) {
			if (c[1] === 'th') isHeader = true;
			cells.push(cellText(c[2]));
		}
		if (cells.length) rows.push({ isHeader, cells });
	}

	const headers = rows.filter((x) => x.isHeader);
	const body = rows.filter((x) => !x.isHeader);
	if (!headers.length || !body.length) return new Map();

	// The label row is the last header row; a preceding header row is the context grouping.
	const columnRow = headers[headers.length - 1].cells;
	const groupRow = headers.length > 1 ? headers[headers.length - 2].cells : null;
	const map = columnMap(groupRow, columnRow);

	const out = new Map();
	for (const { cells } of body) {
		const name = cells[0];
		if (!name) continue;
		const values = cells.slice(1);
		if (values.length !== map.length)
			throw new Error(
				`openai collector: row "${name}" has ${values.length} price cells but the header declares ` +
					`${map.length}. Table structure drifted; refusing to guess.`
			);
		const prices = {};
		for (let i = 0; i < map.length; i++) {
			const v = parseCell(values[i]);
			if (typeof v === 'number') prices[map[i]] = v;
		}
		out.set(name, prices);
	}
	return out;
}

/**
 * Parse the island's props.rows payload.
 * Returns Map(rawDisplayName -> { variation: price }). Short context only, positional.
 */
function parsePayloadRows(props) {
	const rows = Array.isArray(props.rows) ? props.rows[1] : null;
	if (!Array.isArray(rows) || !rows.length)
		throw new Error('openai collector: standard island carries no props.rows array. Refusing to guess.');

	const out = new Map();
	for (const row of rows) {
		const cells = Array.isArray(row) ? row[1] : null;
		if (!Array.isArray(cells) || cells.length < 2) continue;
		const values = cells.map((cell) => (Array.isArray(cell) ? cell[1] : cell));
		const name = String(values[0]).trim();
		const slots = values.slice(1);

		const layout = PAYLOAD_LAYOUTS.get(slots.length);
		if (!layout)
			throw new Error(
				`openai collector: payload row "${name}" has ${slots.length} price slots, and only ` +
					`${[...PAYLOAD_LAYOUTS.keys()].join('/')} are mapped. OpenAI changed the column set; map the ` +
					`new shape deliberately rather than reading values off by one.`
			);

		const prices = {};
		for (let i = 0; i < layout.length; i++) {
			const v = parseSlot(slots[i]);
			if (typeof v === 'number') prices[layout[i]] = v;
		}
		out.set(name, prices);
	}
	return out;
}

/**
 * Map a raw page display name to its bare canonical id.
 * Strips a trailing " (<272K context length)" / " (< ... )" suffix (the STANDARD tier) so the base id
 * is recovered. A ">" / "> ... context length" suffix would be a long-context ROW rather than a
 * column group, and is rejected so the surcharged tier can never be read as the standard rate.
 * Returns null for a name we must not map.
 */
function canonicalFromName(rawName) {
	const name = rawName.trim();
	if (/\(\s*>/.test(name)) return null;
	return name.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
}

/**
 * Cross-check the payload against the rendered table wherever both describe the same model.
 *
 * This is what makes the payload's positional layout trustworthy: the table says which column is
 * which, so if the payload's slots ever stop lining up with it, we find out here instead of
 * publishing a cached-input rate as an input rate.
 */
function crossCheck(canonical, fromTable, fromPayload) {
	for (const [variation, payloadValue] of Object.entries(fromPayload)) {
		const tableValue = fromTable[variation];
		if (typeof tableValue !== 'number') continue;
		if (!nearly(payloadValue, tableValue))
			throw new Error(
				`openai collector: payload/table disagreement for ${canonical} ${variation} - payload says ` +
					`${payloadValue}, the rendered table says ${tableValue}. One of the two shapes drifted; ` +
					`refusing to emit a possibly-mis-parsed set.`
			);
	}
}

/**
 * PIN: after building every record, assert gpt-4o's standard tuple is $2.5 in / $10 out. Guards against
 * an upstream re-scale silently rescaling every price, against a wrong-tier pick (e.g. taking the
 * long-context or batch tuple), and against a mis-parse. Throws on mismatch.
 */
function assertPin(byId) {
	const p = byId.get(PIN_ID);
	if (!p) {
		// gpt-4o is expected on this page; its absence means a name/structure drift the parser missed.
		throw new Error(
			`openai collector: PIN model "${PIN_ID}" not found among parsed rows - the page structure or ` +
				`its display name drifted. Refusing to emit a possibly-mis-parsed set.`
		);
	}
	if (!nearly(p.prices.input, PIN_EXPECT.input) || !nearly(p.prices.output, PIN_EXPECT.output)) {
		throw new Error(
			`openai collector: PIN FAILED for ${PIN_ID} - got input=${p.prices.input} output=${p.prices.output}, ` +
				`expected $${PIN_EXPECT.input}/$${PIN_EXPECT.output}. Either OpenAI changed the price, the parser ` +
				`picked the wrong tier (long-context/batch), or the page structure changed; refusing to emit.`
		);
	}
}

/**
 * COVERAGE: every tracked model must have been parsed, unless it is documented in PAGE_ABSENT.
 *
 * The failure this exists to catch is not a crash but a silence: a new column once made six tracked
 * models stop matching the parser, and the collector reported success on the remaining 13 for a full
 * day. A collector that quietly covers less than it claims is worse than one that fails.
 */
function assertCoverage(byId) {
	const missing = [...TRACKED].filter((id) => !byId.has(id) && !PAGE_ABSENT.has(id));
	if (missing.length)
		throw new Error(
			`openai collector: ${missing.length} tracked model(s) were not found on the pricing page: ` +
				`${missing.join(', ')}. Either the parse drifted (fix it) or OpenAI removed them (record that in ` +
				`PAGE_ABSENT with a reason). Refusing to report partial coverage as success.`
		);
}

/**
 * Collect OpenAI standard-tier prices. Returns array of
 *   { provider, model_id, display_name, prices, unit, source_url, source_kind, confidence,
 *     known_mapping }
 * Fails loud on drift. Models on the page that we do not track are reported via getNotices().
 */
export async function collect() {
	notices = [];

	const rawHtml = await fetchPricingHtml();
	const { props, inner } = standardIsland(rawHtml);

	const tableRows = parseRenderedTable(inner);
	const payloadRows = parsePayloadRows(props);

	// canonical id -> { display, prices }. The rendered table is consulted FIRST and wins where the two
	// overlap: it is labelled, and it is the only source for the long-context tier.
	const byId = new Map();
	const untracked = new Map();

	for (const [source, rows] of [
		['table', tableRows],
		['payload', payloadRows],
	]) {
		for (const [rawName, prices] of rows) {
			const canonical = canonicalFromName(rawName);
			if (!canonical) continue; // a long-context row; never read as the standard rate

			if (!TRACKED.has(canonical)) {
				if (!KNOWN_UNTRACKED.has(canonical)) untracked.set(canonical, rawName.trim());
				continue;
			}

			const existing = byId.get(canonical);
			if (existing) {
				// The table was parsed first, so this is the payload confirming it.
				if (source === 'payload') crossCheck(canonical, existing.prices, prices);
				continue;
			}

			// a real text model row must have both input + output
			if (typeof prices.input !== 'number' || typeof prices.output !== 'number') continue;
			byId.set(canonical, { display: rawName.trim(), prices });
		}
	}

	if (!byId.size)
		throw new Error(
			'openai collector: parsed the standard island but no row mapped to a tracked OpenAI model - ' +
				'name/structure drift. Refusing to guess.'
		);

	assertPin(byId);
	assertCoverage(byId);

	for (const [canonical, display] of untracked) {
		notices.push({
			kind: 'untracked_model',
			provider: PROVIDER,
			model_id: canonical,
			display_name: display,
			source_url: SOURCE_URL,
			message:
				`"${display}" is priced on OpenAI's own pricing page but is in neither TRACKED nor ` +
				`KNOWN_UNTRACKED. Add it to one of them: TRACKED to start recording it, KNOWN_UNTRACKED ` +
				`with a reason to keep ignoring it.`,
		});
	}

	const results = [];
	for (const [model_id, { display, prices }] of byId) {
		results.push({
			provider: PROVIDER,
			model_id,
			display_name: display,
			prices,
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: true,
		});
	}
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => {
			console.log(JSON.stringify(r, null, 2));
			for (const n of getNotices()) console.error(`NOTICE: ${n.message}`);
		})
		.catch((e) => {
			console.error('openai collector failed:', e.message);
			process.exit(1);
		});
}
