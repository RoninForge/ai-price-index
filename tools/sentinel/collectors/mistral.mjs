// tools/sentinel/collectors/mistral.mjs  (MIT)
// First-party Mistral price collector.
//
// Source: https://docs.mistral.ai/inference/pricing - server-rendered HTML. (mistral.ai/pricing/api/
// now 301s here; it was a card layout until 2026-10, when the per-model API prices moved into real
// <table>s on the docs site.) The page has one <section id="..."> per family, each holding one table:
//     flagship            Model | Input | Cached input | Output     (per M tokens)
//     specialized         OCR / audio / moderation, priced per page / minute / chars -> skipped
//     third-party-hosted  models Mistral resells (Z.ai GLM)                       -> skipped
//     code                Codestral (+ Codestral Embed, input-only)
// Every cell is read by its COLUMN LABEL, never by position, and a header we do not recognise throws.
//
// The SSR table is the default view: "Regional inference" unchecked, tier "Standard" pressed. Batch,
// Priority and regional prices are client-side toggles and are not read.
//
// A cell may render a sale: <del>[Original price: ]$X</del><ins>[Sale price: ]$Y</ins>. The SALE
// price is what Mistral charges and is what we emit; the struck list price is returned in `list_prices`
// so a human can record it in notes. Mistral publishes no end date for a sale.
//
// Fail loud: no priced section, an unknown column header, or a TRACKED id missing all THROW.

import { fetchText } from '../lib.mjs';

export const PROVIDER = 'mistral';
const SOURCE_URL = 'https://docs.mistral.ai/inference/pricing';

// Lower-cased model name (as it appears on the page) -> canonical id we publish under.
// Unknown names fall through to a slug and surface as NEW.
const NAME_TO_CANONICAL = {
	'mistral large 4': 'mistral-large-4',
	'mistral large 3': 'mistral-large-3',
	'mistral medium 3.5': 'mistral-medium-3.5',
	'mistral small 4': 'mistral-small-4',
	'devstral 2': 'devstral-2',
	'devstral small 2': 'devstral-small-2',
	'codestral': 'codestral-25.08',
	'magistral medium': 'magistral-medium',
	'magistral small': 'magistral-small',
	'ministral 3 3b': 'ministral-3-3b',
	'ministral 3 8b': 'ministral-3-8b',
	'ministral 3 14b': 'ministral-3-14b',
};

// A name that looks like a Mistral model, not a third-party or task SKU.
const NAME_LINE_RE =
	/^(Mistral (?:Large|Medium|Small)(?: \d[\d.]*)?|Magistral (?:Medium|Small)|Ministral [\dA-Za-z. ()-]+|Devstral(?: Small)?(?: \d)?|Codestral|Pixtral[\w. ]*)$/;

// Every id we publish as current; collect() throws if one is not parsed.
const TRACKED = new Set([
	'codestral-25.08',
	'ministral-3-14b',
	'ministral-3-3b',
	'ministral-3-8b',
	'mistral-large-3',
	'mistral-large-4',
	'mistral-medium-3.5',
	'mistral-small-4',
]);

// Sections that are never per-M-token chat models, with the reason. Any other section is read.
const SKIP_SECTIONS = {
	specialized: 'OCR, audio and moderation SKUs priced per page / minute / character, not per token',
	'third-party-hosted': 'third-party models resold on the Mistral API; they belong to their own provider',
};

// Column label (lower-cased) -> variation. Model is the name column.
const COLUMNS = {
	model: 'model',
	input: 'input',
	'cached input': 'cache_read',
	output: 'output',
};

// A priced row whose name is not a Mistral model: skipped if a rule matches, else reported via
// getNotices().
const UNTRACKED_RULES = [
	[(row) => /^Classifier API model\b/.test(row.title), 'fine-tuned classifier SKU, not a general chat model'],
];

let notices = [];

/** Read by run.mjs after a successful collect(); see tools/sentinel/README.md. */
export function getNotices() {
	return notices;
}

function decode(s) {
	return s
		.replace(/<!-- -->/g, '')
		.replace(/&amp;/g, '&')
		.replace(/&#x27;|&apos;|&#39;/g, "'")
		.replace(/&nbsp;/g, ' ');
}

function textOf(html) {
	return decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parsePrice(s) {
	const m = String(s).match(/^\$\s*([0-9]+(?:\.[0-9]+)?)$/);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) ? n : null;
}

/** A price cell -> { price, list } (list set only on a sale), or null if it is not a plain $/M figure. */
function parseCell(html) {
	const ins = html.match(/<ins\b[^>]*>([\s\S]*?)<\/ins>/);
	const del = html.match(/<del\b[^>]*>([\s\S]*?)<\/del>/);
	const strip = (h) => textOf(h.replace(/<span class="sr-only">[\s\S]*?<\/span>/g, ''));
	if (ins) {
		const price = parsePrice(strip(ins[1]));
		const list = del ? parsePrice(strip(del[1])) : null;
		return price === null ? null : { price, list };
	}
	const price = parsePrice(strip(html));
	return price === null ? null : { price, list: null };
}

function slugify(name) {
	return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Collect Mistral API model prices.
 * Returns array of { provider, model_id, display_name, prices:{input,output,cache_read?}, list_prices?,
 *                    unit, source_url, source_kind, confidence, known_mapping }. Fails loud on drift.
 */
export async function collect() {
	const html = await fetchText(SOURCE_URL);
	notices = [];

	const sections = [...html.matchAll(/<section id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)];
	if (!sections.some(([, id]) => id === 'flagship'))
		throw new Error('mistral collector: no <section id="flagship"> found - markup drifted. Refusing to guess.');

	const byModel = new Map(); // canonical -> { display, known, prices, list_prices }
	for (const [, sectionId, body] of sections) {
		if (SKIP_SECTIONS[sectionId]) continue;
		const table = body.match(/<table[\s\S]*?<\/table>/);
		if (!table) continue;
		const rows = [...table[0].matchAll(/<tr[\s\S]*?<\/tr>/g)].map(([r]) =>
			[...r.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((m) => m[1])
		);
		if (!rows.length) continue;

		const header = rows[0].map((c) => textOf(c).toLowerCase());
		const cols = header.map((h) => COLUMNS[h]);
		const unknown = header.filter((h, i) => !cols[i]);
		if (unknown.length || cols[0] !== 'model')
			throw new Error(
				`mistral collector: section "${sectionId}" has unrecognised column(s) ${JSON.stringify(unknown)} ` +
					`(header ${JSON.stringify(header)}). Refusing to guess which price is which.`
			);

		for (const cells of rows.slice(1)) {
			const nameCell = cells[0] || '';
			const link = nameCell.match(/<a\b[^>]*>([\s\S]*?)<\/a>/);
			const title = textOf(link ? link[1] : nameCell).replace(/\s*↗\s*$/, '').trim();

			const prices = {};
			const list_prices = {};
			for (let i = 1; i < cells.length; i++) {
				const variation = cols[i];
				const cell = parseCell(cells[i]);
				if (!variation || !cell) continue;
				prices[variation] = cell.price;
				if (cell.list !== null) list_prices[variation] = cell.list;
			}
			if (prices.input === undefined || prices.output === undefined) continue; // embeddings, per-unit SKUs

			if (!NAME_LINE_RE.test(title)) {
				const row = { title };
				if (UNTRACKED_RULES.some(([match]) => match(row))) continue;
				if (!notices.some((n) => n.display_name === title)) {
					notices.push({
						kind: 'untracked_model',
						provider: PROVIDER,
						model_id: slugify(title),
						display_name: title,
						source_url: SOURCE_URL,
						message:
							`"${title}" is priced per-1M-tokens ($${prices.input} in / $${prices.output} out) in the ` +
							`"${sectionId}" section of Mistral's own pricing page but is not a recognised Mistral model ` +
							`name and matches no UNTRACKED_RULES entry. Add it to NAME_TO_CANONICAL + TRACKED to start ` +
							`recording it, or add a rule with a reason to keep ignoring it.`,
					});
				}
				continue;
			}

			const norm = title.toLowerCase().replace(/[()]/g, ' ').replace(/\s*-\s*/g, ' ').replace(/\s+/g, ' ').trim();
			const canonical = NAME_TO_CANONICAL[norm] || slugify(title);
			if (!byModel.has(canonical)) {
				byModel.set(canonical, {
					display: title,
					known: Boolean(NAME_TO_CANONICAL[norm]),
					prices,
					list_prices: Object.keys(list_prices).length ? list_prices : null,
				});
			}
		}
	}

	const results = [];
	for (const [model_id, { display, known, prices, list_prices }] of byModel) {
		results.push({
			provider: PROVIDER,
			model_id,
			display_name: display,
			prices,
			...(list_prices ? { list_prices } : {}),
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: known,
		});
	}

	if (!results.length)
		throw new Error('mistral collector: found pricing tables but extracted zero model rows - structure drift.');
	const missing = [...TRACKED].filter((id) => !byModel.has(id));
	if (missing.length)
		throw new Error(
			`mistral collector: tracked model(s) not parsed from the pricing page: ${missing.join(', ')}. ` +
				`Either the page markup drifted or the model left the page (record the retirement and remove it ` +
				`from TRACKED). Refusing to report partial coverage as success.`
		);
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('mistral collector failed:', e.message);
			process.exit(1);
		});
}
