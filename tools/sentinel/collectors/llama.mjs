// tools/sentinel/collectors/llama.mjs  (MIT)
// Llama (Meta open-weights) reference-price collector.
//
// There is NO first-party Meta price - Meta ships weights, not a hosted API price. We therefore
// reference a major hosting provider (Together AI) as an aggregator source, ALWAYS labelled:
//   source_kind: "aggregator"
//   source_url:  the Together URL actually used
//   notes:       "No first-party Meta price; Together AI reference host."
//
// Together's pricing page (https://www.together.ai/pricing) is 200 but JS-rendered (~509KB) with only
// partial name->price colocation. So:
//   1. Try a TIGHT scrape: find a model name, look at a small window of text right after it for the
//      first two "$X.XX" figures (input, output). Accept only if both parse cleanly -> confidence "inferred".
//   2. For any mainstream Llama model not cleanly scraped, FALL BACK to a small hardcoded set
//      -> confidence "estimated", clearly labelled.
//
// There is no meta-llama provider in current.json/index.json today, so every Llama model is NEW.

import { fetchText } from '../lib.mjs';

export const PROVIDER = 'meta-llama';
const PRICING_URL = 'https://www.together.ai/pricing';
const NOTE = 'No first-party Meta price; Together AI reference host.';

// Mainstream Llama models we want a reference price for, with the canonical id we publish under
// and a hardcoded estimated fallback (usd_per_mtok). The fallback is used only when the live scrape
// for that model is not clean. Estimates are conservative public Together figures, clearly labelled.
const TARGETS = [
	{
		model_id: 'llama-4-scout',
		display: 'Llama 4 Scout',
		matchers: [/llama\s*4\s*scout/i],
		fallback: { input: 0.18, output: 0.59 },
	},
	{
		model_id: 'llama-4-maverick',
		display: 'Llama 4 Maverick',
		matchers: [/llama\s*4\s*maverick/i],
		fallback: { input: 0.27, output: 0.85 },
	},
	{
		model_id: 'llama-3.3-70b',
		display: 'Llama 3.3 70B',
		matchers: [/llama\s*3\.3\s*70b/i],
		fallback: { input: 0.88, output: 0.88 },
	},
	{
		model_id: 'llama-3.1-405b',
		display: 'Llama 3.1 405B',
		matchers: [/llama\s*3\.1\s*405b/i],
		fallback: { input: 3.5, output: 3.5 },
	},
	{
		model_id: 'llama-3.1-8b',
		display: 'Llama 3.1 8B',
		matchers: [/llama\s*3\.1\s*8b/i],
		fallback: { input: 0.18, output: 0.18 },
	},
];

// Window of characters after a name match in which we trust a co-located price.
const PRICE_WINDOW = 140;
const PRICE_RE = /\$\s*([0-9]+(?:\.[0-9]+)?)/g;

/** Try to scrape input/output (usd_per_mtok) for one target from the page text. Returns null if not clean. */
function scrapeOne(text, target) {
	for (const matcher of target.matchers) {
		const m = matcher.exec(text);
		if (!m) continue;
		const start = m.index + m[0].length;
		const window = text.slice(start, start + PRICE_WINDOW);
		const nums = [];
		let pm;
		PRICE_RE.lastIndex = 0;
		while ((pm = PRICE_RE.exec(window)) && nums.length < 2) {
			const n = parseFloat(pm[1]);
			if (Number.isFinite(n) && n > 0 && n < 1000) nums.push(n);
		}
		if (nums.length >= 2) return { input: nums[0], output: nums[1], clean: true };
	}
	return null;
}

/**
 * Collect Together-reference Llama prices.
 * Returns an array of:
 *   { provider, model_id, prices:{input,output}, unit, source_url, source_kind, confidence, notes, scraped }
 * Each variation becomes its own contribution record downstream. confidence is "inferred" when
 * scraped cleanly from the live page, "estimated" when it falls back to the hardcoded set.
 * Network failure -> the whole list falls back to estimated (the page is best-effort, not load-bearing).
 */
export async function collect() {
	let pageText = '';
	let usedUrl = PRICING_URL;
	try {
		pageText = await fetchText(PRICING_URL);
		// crude HTML-to-text: drop tags so name/price text sits adjacent
		pageText = pageText.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
	} catch {
		pageText = ''; // fall through to all-estimated
	}

	const results = [];
	for (const t of TARGETS) {
		const scraped = pageText ? scrapeOne(pageText, t) : null;
		const prices = scraped ? { input: scraped.input, output: scraped.output } : { ...t.fallback };
		const confidence = scraped ? 'inferred' : 'estimated';
		results.push({
			provider: PROVIDER,
			model_id: t.model_id,
			display_name: t.display,
			prices,
			unit: 'usd_per_mtok',
			source_url: usedUrl,
			source_kind: 'aggregator',
			confidence,
			notes: NOTE,
			scraped: Boolean(scraped),
		});
	}
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('llama collector failed:', e.message);
			process.exit(1);
		});
}
