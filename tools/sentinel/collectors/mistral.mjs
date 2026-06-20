// tools/sentinel/collectors/mistral.mjs  (MIT)
// First-party Mistral price collector.
//
// Source: https://mistral.ai/pricing/  - server-rendered HTML. The API model prices are NOT in a
// <table>; each model is a card that renders, in document order, as:
//     <model name heading> ... Input (/M tokens) $X ... Output (/M tokens) $Y ...
// So we strip tags to newline-separated text and, for every "Input (/M tokens)" anchor, read the next
// "$" figure as input, then the next "Output (/M tokens)" anchor's "$" figure as output, and walk
// backwards a short window to the nearest model-name heading.
//
// All prices are per million tokens already (the "(/M tokens)" label) -> usd_per_mtok as-is.
// Audio / transcription / embedding cards use different labels ("per 1k characters", "Audio Input/min",
// single "Input (/M tokens)" with no output) and are skipped: we only emit a card that has BOTH an
// Input (/M tokens) and an Output (/M tokens) figure.
//
// Fail loud: if zero "Input (/M tokens)" anchors are found at all, THROW (page went JS-only / drifted).

import { fetchText } from '../lib.mjs';

export const PROVIDER = 'mistral';
const SOURCE_URL = 'https://mistral.ai/pricing/';

// Lower-cased model heading (as it appears on the page) -> canonical id we publish under.
// Unknown headings fall through to a slug and surface as NEW. Headings on the page sometimes carry a
// trailing tier word ("Open"/"Premier"/"Labs") on the next line, not on the name line, so the name
// line itself is clean.
const NAME_TO_CANONICAL = {
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

// A line that looks like a Mistral model NAME (heading), not prose. Anchored to the known families so
// a descriptive sentence ("For coding: Mistral Medium 3.5.") is not mistaken for a heading.
const NAME_LINE_RE =
	/^(Mistral (?:Large|Medium|Small)(?: \d[\d.]*)?|Magistral (?:Medium|Small)|Ministral [\dA-Za-z. ]+|Devstral(?: Small)?(?: \d)?|Codestral|Pixtral[\w. ]*)$/;

function parsePrice(s) {
	const m = String(s).match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) ? n : null;
}

function slugify(name) {
	return name.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Collect Mistral API model prices.
 * Returns array of { provider, model_id, display_name, prices:{input,output}, unit, source_url,
 *                    source_kind, confidence, known_mapping }. Fails loud on structural drift.
 */
export async function collect() {
	const html = await fetchText(SOURCE_URL);
	const text = html
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, '\n')
		.replace(/&amp;/g, '&')
		.replace(/&#x27;|&apos;/g, "'");
	const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);

	// indices of "Input (/M tokens)" and "Output (/M tokens)" anchor lines
	const inputAnchors = [];
	for (let i = 0; i < lines.length; i++) {
		if (/^Input \(\/M tokens\)$/i.test(lines[i])) inputAnchors.push(i);
	}
	if (!inputAnchors.length)
		throw new Error(
			'mistral collector: no "Input (/M tokens)" anchor found - page is JS-rendered or drifted. Refusing to guess.'
		);

	const byModel = new Map(); // canonical -> { display, prices }
	for (const ai of inputAnchors) {
		// input price is the first "$" within the next couple of lines
		let input = null;
		for (let j = ai + 1; j < Math.min(ai + 4, lines.length); j++) {
			input = parsePrice(lines[j]);
			if (input !== null) break;
		}
		if (input === null) continue;

		// output anchor must appear shortly after the input anchor for the SAME card
		let output = null;
		for (let j = ai + 1; j < Math.min(ai + 10, lines.length); j++) {
			if (/^Output \(\/M tokens\)$/i.test(lines[j])) {
				for (let k = j + 1; k < Math.min(j + 4, lines.length); k++) {
					output = parsePrice(lines[k]);
					if (output !== null) break;
				}
				break;
			}
		}
		if (output === null) continue; // input-only card (e.g. embeddings) - skip

		// walk back to the nearest model-name heading
		let display = null;
		for (let j = ai - 1; j >= Math.max(0, ai - 14); j--) {
			if (NAME_LINE_RE.test(lines[j])) {
				display = lines[j];
				break;
			}
		}
		if (!display) continue;

		const norm = display.toLowerCase().replace(/\s+/g, ' ').trim();
		const canonical = NAME_TO_CANONICAL[norm] || slugify(display);
		// first card wins per model (the page lists a model once in the API table; later duplicate
		// marketing cards, if any, are ignored).
		if (!byModel.has(canonical)) {
			byModel.set(canonical, {
				display,
				known: Boolean(NAME_TO_CANONICAL[norm]),
				prices: { input, output },
			});
		}
	}

	const results = [];
	for (const [model_id, { display, known, prices }] of byModel) {
		results.push({
			provider: PROVIDER,
			model_id,
			display_name: display,
			prices,
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: known,
		});
	}

	if (!results.length)
		throw new Error('mistral collector: found price anchors but extracted zero model rows - structure drift.');
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
