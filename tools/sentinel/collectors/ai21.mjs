// tools/sentinel/collectors/ai21.mjs  (MIT)
// First-party AI21 price collector.
//
// Source: https://www.ai21.com/pricing/ - server-rendered WordPress HTML, no JS/auth needed.
// The model prices are NOT in a <table>; each model is a card inside a single block:
//     <div class="block b-cards b-cards--type-models">
//       <div class="card"><div class="card__body">
//         <h3 class="card__title">Jamba Mini</h3>
//         <div class="card__text">...</div>
//         <div class="card__footer">$0.2 / 1M input tokens<br />$0.4 / 1M output tokens</div>
//
// Two structural defences, both earned elsewhere in this directory:
//   1. Anchor on the `b-cards--type-models` block, not on "$". The SAME page prices the plans
//      ("Free Trial - $10 credits for 7 days"), so a naive dollar scraper publishes a trial credit
//      as a token price. The block class is what separates a model card from a plan card.
//   2. Read each figure by its own LABEL ("/ 1M input tokens"), never by position within the card.
//
// Prices are already per million tokens -> usd_per_mtok as-is.
// Fail loud: no models block, or zero cards parsed, or a TRACKED model missing -> THROW. A page we
// received but cannot understand means AI21 is no longer being price-checked, which is a finding,
// not a quiet zero.

import { fetchText } from '../lib.mjs';

export const PROVIDER = 'ai21';
const SOURCE_URL = 'https://www.ai21.com/pricing/';

// Lower-cased card title as it appears on the page -> canonical id we publish under.
const NAME_TO_CANONICAL = {
	'jamba mini': 'jamba-mini',
	'jamba large': 'jamba-large',
};

// Every id we publish as current; collect() throws if one is not parsed.
const TRACKED = new Set(['jamba-large', 'jamba-mini']);

// Tracked but legitimately absent from the page, with the reason. Empty: AI21 prices both models
// it sells on this page.
const PAGE_ABSENT = {};

// On the page, deliberately untracked, with the reason. Empty: both cards are general chat models
// we record.
const KNOWN_UNTRACKED = {};

const MODELS_BLOCK_RE = /<div class="block b-cards b-cards--type-models"[\s\S]*?(?=<div class="block (?!b-cards b-cards--type-models)|<footer)/i;
const CARD_RE = /<h3 class="card__title">([\s\S]*?)<\/h3>[\s\S]*?<div class="card__footer">([\s\S]*?)<\/div>/gi;

let notices = [];

/** Read by run.mjs after a successful collect(); see tools/sentinel/README.md. */
export function getNotices() {
	return notices;
}

function decode(s) {
	return String(s)
		.replace(/<[^>]+>/g, ' ')
		.replace(/&#0?38;|&amp;/g, '&')
		.replace(/&#x27;|&#0?39;|&apos;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Read one labelled per-MTok figure out of a card footer. Label-driven, never positional. */
function priceFor(footerText, label) {
	const re = new RegExp(`\\$\\s*([0-9]+(?:\\.[0-9]+)?)\\s*/\\s*1M\\s+${label}\\s+tokens`, 'i');
	const m = footerText.match(re);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) ? n : null;
}

function slugify(name) {
	return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Collect AI21 foundation-model prices.
 * Returns array of { provider, model_id, display_name, prices:{input,output}, unit, source_url,
 *                    source_kind, confidence, known_mapping }. Fails loud on structural drift.
 */
export async function collect() {
	const html = await fetchText(SOURCE_URL);
	notices = [];

	const block = html.match(MODELS_BLOCK_RE);
	if (!block)
		throw new Error(
			'ai21 collector: no "b-cards--type-models" block found - markup drifted or the page went ' +
				'JS-only. Refusing to scrape bare "$" figures, which would read the plan trial credit as a price.'
		);

	const byModel = new Map();
	for (const m of block[0].matchAll(CARD_RE)) {
		const display = decode(m[1]);
		const footer = decode(m[2]);
		if (!display) continue;

		const input = priceFor(footer, 'input');
		const output = priceFor(footer, 'output');
		const norm = display.toLowerCase().replace(/\s+/g, ' ').trim();
		const canonical = NAME_TO_CANONICAL[norm];

		if (!canonical) {
			const id = slugify(display);
			if (KNOWN_UNTRACKED[id]) continue;
			notices.push({
				kind: 'untracked_model',
				provider: PROVIDER,
				model_id: id,
				display_name: display,
				source_url: SOURCE_URL,
				message:
					`"${display}" is a model card on AI21's own pricing page ` +
					(input !== null && output !== null
						? `($${input} in / $${output} out per 1M tokens) `
						: `(prices did not parse from "${footer}") `) +
					`but is not in NAME_TO_CANONICAL. Add it to NAME_TO_CANONICAL + TRACKED to start ` +
					`recording it, or add it to KNOWN_UNTRACKED with a reason to keep ignoring it.`,
			});
			continue;
		}
		if (input === null || output === null) continue;
		if (!byModel.has(canonical)) {
			byModel.set(canonical, { display, prices: { input, output } });
		}
	}

	const results = [];
	for (const [model_id, { display, prices }] of byModel) {
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

	if (!results.length)
		throw new Error('ai21 collector: found the models block but extracted zero model rows - structure drift.');
	const missing = [...TRACKED].filter((id) => !byModel.has(id) && !PAGE_ABSENT[id]);
	if (missing.length)
		throw new Error(
			`ai21 collector: tracked model(s) not parsed from the pricing page: ${missing.join(', ')}. ` +
				`Either the page markup drifted or the model left the page (record the retirement and remove it ` +
				`from TRACKED). Refusing to report partial coverage as success.`
		);
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('ai21 collector failed:', e.message);
			process.exit(1);
		});
}
