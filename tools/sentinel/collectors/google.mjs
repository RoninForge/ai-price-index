// tools/sentinel/collectors/google.mjs  (MIT)
// First-party Google (Gemini) price collector.
//
// Source: https://aistudio.google.com/docs/pricing. On 2026-11-04 ai.google.dev/gemini-api/docs/pricing
// started 301-ing there, and the new page is client-rendered (zero <table> elements in the HTML).
// Google publishes the same document as Markdoc at `<page>.md` and lists it in
// aistudio.google.com/llms.txt; that copy is what we parse. It is locale-invariant (identical bytes
// with and without Accept-Language), which retires the old machine-translated-locale retry loop.
//
// Shape (verified 2026-11-05): one `## <Model name>  {% id="<api id>" %}` section per model, then an
// optional `{% callout %}`, then `{% tabs %}` whose first tab is Standard (or a bare `{% table %}`).
// A table is `* cell` bullets, rows separated by `---`; the first row is the header and the
// "Paid Tier" column is the one we read. Paid cells are one of:
//   tiered:     "$2.00, prompts <= 200k tokens  $4.00, prompts > 200k tokens"
//   flat:       "$0.30 (text / image / video) $1.00 (audio)"   (first $ = text input)
//   dated:      "$2.00 through November 30, 2026. $4.00 starting December 1, 2026."   (first $ = current)
//
// Mapping (PAID tier, Standard table only, text chat models):
//   Input price              -> input,      tier2_input when the cell marks a >200k tier
//   Output price             -> output,     tier2_output ditto
//   Context caching price    -> cache_read, tier2_cache_read ditto, after the per-hour storage clause
//                               is stripped (that cell carries both)
// The model id is the section's own `{% id %}`, so a new model arrives under Google's API id.
//
// Deprecated models are skipped: a caution/warning callout that names a deprecation, between the
// section heading and its first table, means the model must not be drafted as a NEW current price.
// If the document says "deprecat" but no such callout matches, the marker drifted: THROW.
// Fail loud on any structural drift rather than report partial coverage as success.

import { fetchText } from '../lib.mjs';

export const PROVIDER = 'google';
const SOURCE_URL = 'https://aistudio.google.com/docs/pricing';
const MARKDOC_URL = `${SOURCE_URL}.md`;

// Lower-cased heading -> canonical id, used only when a section carries no `{% id %}`.
const NAME_TO_CANONICAL = {
	'gemini 4 argon': 'gemini-4-argon',
	'gemini 3.8 flash': 'gemini-3.8-flash',
	'gemini 3.6 flash': 'gemini-3.6-flash',
	'gemini 3.5 flash-lite': 'gemini-3.5-flash-lite',
	'gemini 3.1 flash-lite': 'gemini-3.1-flash-lite',
	'gemini 3.1 pro preview': 'gemini-3.1-pro-preview',
	'gemini 3 flash preview': 'gemini-3-flash-preview',
	'gemini 2.5 pro': 'gemini-2.5-pro',
	'gemini 2.5 flash': 'gemini-2.5-flash',
	'gemini 2.5 flash-lite': 'gemini-2.5-flash-lite',
};

// A text chat model worth pricing: any "Gemini <version> <Name>[-Lite| Preview| Lite]".
const TEXT_MODEL_HEADING_RE = /^Gemini [\d.]+ [A-Za-z]+(?:-Lite| Preview| Lite)?$/i;
const NON_TEXT_RE = /(image|video|tts|live|translate|transcribe|embedding|audio|nano banana|robotics|computer use|guard|omni|🍌)/i;

const CALLOUT_RE = /\{%\s*callout\b[^%]*\btype="(?:warning|caution)"[^%]*%\}([\s\S]*?)\{%\s*\/callout\s*%\}/gi;
const DEPRECATION_WORDS_RE = /(deprecat|discontinu|retir|shut[\s-]*down|sunset)/i;
const DEPRECATION_LINK_RE = /\/docs\/deprecations/i;

const STORAGE_CLAUSE_RE = /\$\s*[0-9]+(?:\.[0-9]+)?\s*\/\s*1,?000,?000 tokens per hour[^$]*/gi;
const IGNORED_ROW_LABEL_RE = /^(grounding with google|used to improve our products|context caching \(storage\)|tuning price|google search)/i;

function cleanCell(s) {
	return s
		.replace(/\{%\s*sup\s*%\}[\s\S]*?\{%\s*\/sup\s*%\}/g, ' ')
		.replace(/\{%[\s\S]*?%\}/g, ' ')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/[*`]/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/\s+/g, ' ')
		.trim();
}

/** All "$X.XX" numbers in a cell, in order. */
function allPrices(s) {
	const out = [];
	const re = /\$\s*([0-9]+(?:\.[0-9]+)?)/g;
	let m;
	while ((m = re.exec(s))) {
		const n = parseFloat(m[1]);
		if (Number.isFinite(n)) out.push(n);
	}
	return out;
}

function slugify(name) {
	return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

/** From a Paid-Tier cell, return { std, tier2 } prices. tier2 only when the cell marks a >200k tier. */
function parseTierCell(cell) {
	const nums = allPrices(cell);
	if (!nums.length) return null;
	const std = nums[0];
	let tier2 = null;
	if (/(>\s*200,?000|>\s*200k|200,?000 tokens)/i.test(cell) && nums.length >= 2) tier2 = nums[1];
	return { std, tier2 };
}

/** Split the document into `## ` sections: { title, id, body }. */
function sections(md) {
	const heads = [...md.matchAll(/^## (.*)$/gm)];
	return heads.map((m, i) => {
		const raw = m[1];
		const id = /\{%\s*id="([^"]+)"\s*%\}/.exec(raw)?.[1] ?? null;
		const end = i + 1 < heads.length ? heads[i + 1].index : md.length;
		return { title: cleanCell(raw), id, body: md.slice(m.index + m[0].length, end) };
	});
}

/** Rows of a Markdoc table body as arrays of cleaned cells. */
function tableRows(tableText) {
	return tableText
		.split(/^\s*---\s*$/m)
		.map((chunk) => {
			const cells = [];
			for (const line of chunk.split('\n')) {
				const bullet = /^\s*\* (.*)$/.exec(line);
				if (bullet) cells.push(bullet[1]);
				else if (cells.length && line.trim()) cells[cells.length - 1] += ` ${line.trim()}`;
			}
			return cells.map(cleanCell);
		})
		.filter((cells) => cells.length);
}

function isDeprecationCallout(inner) {
	return DEPRECATION_WORDS_RE.test(inner) || DEPRECATION_LINK_RE.test(inner);
}

export function parsePricingMarkdoc(md) {
	if (!/^# Gemini Developer API pricing/m.test(md))
		throw new Error('google collector: pricing.md has no "# Gemini Developer API pricing" title - wrong document or drift.');

	const deprecationCallouts = [...md.matchAll(CALLOUT_RE)].filter((m) => isDeprecationCallout(m[1]));
	if (/deprecat/i.test(md) && deprecationCallouts.length === 0)
		throw new Error(
			'google collector: the document mentions deprecation but no deprecation {% callout %} was matched - marker drifted. Refusing to risk emitting a retired model.'
		);

	const byModel = new Map();
	let sawAnyInputRow = false;
	let sawAnyTable = false;
	const unknownRowLabels = new Set();

	for (const sec of sections(md)) {
		if (!TEXT_MODEL_HEADING_RE.test(sec.title) || NON_TEXT_RE.test(sec.title)) continue;
		const norm = sec.title.toLowerCase();
		const canonical = sec.id || NAME_TO_CANONICAL[norm] || slugify(sec.title);
		if (byModel.has(canonical)) continue;

		const table = /\{%\s*table\s*%\}([\s\S]*?)\{%\s*\/table\s*%\}/.exec(sec.body);
		if (!table) continue;
		sawAnyTable = true;

		const beforeTable = sec.body.slice(0, table.index);
		if ([...beforeTable.matchAll(CALLOUT_RE)].some((m) => isDeprecationCallout(m[1]))) {
			byModel.set(canonical, null);
			continue;
		}

		const [header, ...rows] = tableRows(table[1]);
		const paidCol = header.findIndex((c) => /paid tier/i.test(c));
		if (paidCol < 0)
			throw new Error(`google collector: ${canonical} table header has no "Paid Tier" column (${JSON.stringify(header)}) - drift.`);

		const prices = {};
		for (const cells of rows) {
			const label = (cells[0] || '').toLowerCase();
			const paid = cells[paidCol] ?? '';
			if (/^input price/.test(label)) {
				sawAnyInputRow = true;
				const p = parseTierCell(paid);
				if (p) {
					prices.input = p.std;
					if (p.tier2 !== null) prices.tier2_input = p.tier2;
				}
			} else if (/^output price/.test(label)) {
				const p = parseTierCell(paid);
				if (p) {
					prices.output = p.std;
					if (p.tier2 !== null) prices.tier2_output = p.tier2;
				}
			} else if (/^context caching price/.test(label)) {
				const p = parseTierCell(paid.replace(STORAGE_CLAUSE_RE, ' '));
				if (p) {
					prices.cache_read = p.std;
					if (p.tier2 !== null) prices.tier2_cache_read = p.tier2;
				}
			} else if (cells[0] && !IGNORED_ROW_LABEL_RE.test(cells[0])) {
				unknownRowLabels.add(cells[0]);
			}
		}

		if (typeof prices.input !== 'number' || typeof prices.output !== 'number') continue;
		byModel.set(canonical, { display: sec.title, known: Boolean(sec.id || NAME_TO_CANONICAL[norm]), prices });
	}

	if (unknownRowLabels.size)
		console.warn(
			`google collector: unrecognised pricing row label(s), not collected: ${[...unknownRowLabels].map((l) => JSON.stringify(l)).join(', ')}`
		);
	if (!sawAnyTable) throw new Error('google collector: no {% table %} under any text-model section - structure drift.');
	if (!sawAnyInputRow)
		throw new Error('google collector: tables found but no "Input price" row under any model - drift. Refusing to guess.');

	const results = [];
	for (const [model_id, entry] of byModel) {
		if (!entry) continue;
		results.push({
			provider: PROVIDER,
			model_id,
			display_name: entry.display,
			prices: entry.prices,
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: entry.known,
		});
	}
	if (!results.length) throw new Error('google collector: parsed sections but extracted zero text-model rows - drift.');
	return results;
}

export async function collect() {
	return parsePricingMarkdoc(await fetchText(MARKDOC_URL));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('google collector failed:', e.message);
			process.exit(1);
		});
}
