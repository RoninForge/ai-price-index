// tools/sentinel/collectors/anthropic.mjs  (MIT)
// First-party Anthropic price collector.
//
// Source: https://platform.claude.com/docs/en/docs/about-claude/pricing.md
// This is clean GFM markdown (no JS, no auth). The MAIN per-token table has exactly this header:
//   Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens
// Column -> variation mapping:
//   Base Input Tokens      -> input
//   5m Cache Writes        -> cache_write_5m
//   1h Cache Writes        -> cache_write_1h
//   Cache Hits & Refreshes -> cache_read
//   Output Tokens          -> output
// All prices are usd_per_mtok. Batch / Fast-mode are SEPARATE tables further down and are ignored here.
//
// Fail loud: if the header row above is not found, THROW. Never emit a guessed number.

import { fetchText } from '../lib.mjs';

export const PROVIDER = 'anthropic';
const SOURCE_URL = 'https://platform.claude.com/docs/en/docs/about-claude/pricing.md';

// Column header (normalized lower-case) -> our variation. The presence + order of these is what we
// assert against; we read by matched header position, not by a fixed column index, so a re-order is safe.
const HEADER_TO_VARIATION = {
	'base input tokens': 'input',
	'5m cache writes': 'cache_write_5m',
	'1h cache writes': 'cache_write_1h',
	'cache hits & refreshes': 'cache_read',
	'output tokens': 'output',
};

// Map a display name (already link-stripped + trimmed) to a canonical model id + alias.
// Dated snapshot ids mirror data/ai-price-index/index.json; newer point models use the bare id
// already in the index (claude-opus-4-6/4-7/4-8, claude-sonnet-4-6). Unknown names fall through to
// a slugified id and are surfaced by run.mjs as NEW (e.g. "Claude Mythos 5").
const NAME_TO_CANONICAL = {
	'claude opus 4.8': { model_id: 'claude-opus-4-8' },
	'claude opus 4.7': { model_id: 'claude-opus-4-7' },
	'claude opus 4.6': { model_id: 'claude-opus-4-6' },
	'claude opus 4.5': { model_id: 'claude-opus-4-5-20251101', aliases: ['claude-opus-4-5'] },
	'claude opus 4.1': { model_id: 'claude-opus-4-1-20250805', aliases: ['claude-opus-4-1'] },
	'claude opus 4': { model_id: 'claude-opus-4-20250514' },
	'claude sonnet 4.6': { model_id: 'claude-sonnet-4-6' },
	'claude sonnet 4.5': { model_id: 'claude-sonnet-4-5-20250929', aliases: ['claude-sonnet-4-5'] },
	'claude sonnet 4': { model_id: 'claude-sonnet-4-20250514' },
	'claude haiku 4.5': { model_id: 'claude-haiku-4-5-20251001', aliases: ['claude-haiku-4-5'] },
	'claude haiku 4': { model_id: 'claude-haiku-4-20250514' },
	// The page now prints the family name FIRST (e.g. "Claude Haiku 3.5"); older docs put the
	// version first ("Claude 3.5 Haiku"). Map both orderings to the dated index ids so these
	// known legacy models classify as UNCHANGED, not false-NEW.
	'claude sonnet 3.7': { model_id: 'claude-3-7-sonnet-20250219' },
	'claude 3.7 sonnet': { model_id: 'claude-3-7-sonnet-20250219' },
	'claude sonnet 3.5': { model_id: 'claude-3-5-sonnet-20240620' },
	'claude 3.5 sonnet': { model_id: 'claude-3-5-sonnet-20240620' },
	'claude haiku 3.5': { model_id: 'claude-3-5-haiku-20241022' },
	'claude 3.5 haiku': { model_id: 'claude-3-5-haiku-20241022' },
	'claude opus 3': { model_id: 'claude-3-opus-20240229' },
	'claude 3 opus': { model_id: 'claude-3-opus-20240229' },
	'claude sonnet 3': { model_id: 'claude-3-sonnet-20240229' },
	'claude 3 sonnet': { model_id: 'claude-3-sonnet-20240229' },
	'claude haiku 3': { model_id: 'claude-3-haiku-20240307' },
	'claude 3 haiku': { model_id: 'claude-3-haiku-20240307' },
};

/** Split one GFM table row "| a | b | c |" into trimmed cells. */
function splitRow(line) {
	let s = line.trim();
	if (s.startsWith('|')) s = s.slice(1);
	if (s.endsWith('|')) s = s.slice(0, -1);
	return s.split('|').map((c) => c.trim());
}

/** A GFM separator row like | --- | :---: | ... | */
function isSeparatorRow(cells) {
	return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
}

/** Strip inline markdown links + parenthetical deprecation/retired notes from a model name cell. */
function cleanModelName(cell) {
	let s = cell;
	// [text](url) -> text
	s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	// drop parenthetical status notes such as "(deprecated)" / "(retired ...)" /
	// "(limited availability)" / "(preview)" left after link strip - they are not part of the name
	s = s.replace(/\((?:deprecated|retired|limited[^)]*|preview|legacy|new)[^)]*\)/gi, '');
	// drop any leftover bare parens content that is purely a status note
	s = s.replace(/\(\s*\)/g, '');
	// collapse whitespace, strip markdown emphasis + stray backticks
	s = s.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
	return s;
}

/** Parse a price cell like "$5 / MTok", "$6.25 / MTok", "$0.50 / MTok" -> number, or null if no price. */
function parsePrice(cell) {
	if (!cell) return null;
	const c = cell.trim();
	if (!c || c === '-' || c === 'N/A' || /^n\/?a$/i.test(c)) return null;
	const m = c.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) ? n : null;
}

/**
 * Locate the main pricing table by its header row and return { headerCells, dataLines }.
 * THROWS if the expected header is not present (structure drift).
 */
function locateMainTable(md) {
	const lines = md.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line.includes('|')) continue;
		const cells = splitRow(line).map((c) => c.toLowerCase());
		// header must contain the model column + at least input + output, in the known vocabulary
		const hasModel = cells[0] === 'model' || cells[0].startsWith('model');
		const hasInput = cells.includes('base input tokens');
		const hasOutput = cells.includes('output tokens');
		const next = lines[i + 1];
		if (hasModel && hasInput && hasOutput && next && isSeparatorRow(splitRow(next))) {
			// collect contiguous data rows
			const dataLines = [];
			for (let j = i + 2; j < lines.length; j++) {
				const l = lines[j];
				if (!l.includes('|')) break; // table ended
				const dc = splitRow(l);
				if (isSeparatorRow(dc)) continue;
				dataLines.push(dc);
			}
			return { headerCells: splitRow(line), dataLines };
		}
	}
	throw new Error(
		'anthropic collector: main pricing table header not found ' +
			'("Model | Base Input Tokens | ... | Output Tokens"). Structure drift - refusing to guess.'
	);
}

/**
 * Collect normalized extracted prices for the mainstream Claude models on the pricing page.
 * Returns an array of:
 *   {
 *     provider, model_id, aliases?, display_name,
 *     prices: { input?, output?, cache_read?, cache_write_5m?, cache_write_1h? },  // usd_per_mtok
 *     unit, source_url, source_kind, confidence, known_mapping (bool)
 *   }
 * Fails loud on header/structure drift.
 */
export async function collect() {
	const md = await fetchText(SOURCE_URL);
	const { headerCells, dataLines } = locateMainTable(md);

	// build columnIndex -> variation from the matched header (order-independent)
	const colVariation = {};
	headerCells.forEach((h, idx) => {
		const key = h.toLowerCase();
		if (HEADER_TO_VARIATION[key]) colVariation[idx] = HEADER_TO_VARIATION[key];
	});
	if (!Object.values(colVariation).includes('input') || !Object.values(colVariation).includes('output'))
		throw new Error('anthropic collector: header found but input/output columns not mappable.');

	const results = [];
	for (const cells of dataLines) {
		if (!cells.length) continue;
		const display = cleanModelName(cells[0]);
		if (!display || !/claude/i.test(display)) continue; // skip non-model footnote rows

		const prices = {};
		for (const [idxStr, variation] of Object.entries(colVariation)) {
			const idx = Number(idxStr);
			const price = parsePrice(cells[idx]);
			if (price !== null) prices[variation] = price;
		}
		// require at least input + output to consider it a real model row
		if (typeof prices.input !== 'number' || typeof prices.output !== 'number') continue;

		const norm = display.toLowerCase();
		const mapping = NAME_TO_CANONICAL[norm];
		const model_id = mapping ? mapping.model_id : slugifyClaudeName(display);

		results.push({
			provider: PROVIDER,
			model_id,
			aliases: mapping && mapping.aliases ? mapping.aliases : undefined,
			display_name: display,
			prices,
			unit: 'usd_per_mtok',
			source_url: 'https://docs.claude.com/en/docs/about-claude/pricing',
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: Boolean(mapping),
		});
	}

	if (!results.length)
		throw new Error('anthropic collector: located the table but extracted zero Claude rows - structure drift.');
	return results;
}

/** Fallback slug for an unrecognized display name, e.g. "Claude Mythos 5" -> "claude-mythos-5". */
function slugifyClaudeName(name) {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('anthropic collector failed:', e.message);
			process.exit(1);
		});
}
