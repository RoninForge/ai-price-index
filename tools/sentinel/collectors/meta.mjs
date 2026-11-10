// tools/sentinel/collectors/meta.mjs  (MIT)
// First-party Meta Model API price collector.
//
// Source: https://dev.meta.ai/docs/pricing-rate-limits (read through its Markdown twin, the same
// document with a `.md` suffix, listed in https://dev.meta.ai/llms.txt). Under "## Model pricing"
// each model line is a "### <name>" subsection: a sentence naming the model ids, then a table
//
//   | Usage        | Standard mode (per 1M tokens) | Contributor mode (per 1M tokens) |
//   | Cached input | $0.15                         | $0.002                           |
//   | Input        | $1.25                         | $0.10                            |
//   | Output       | $4.25                         | $0.20                            |
//
// One table prices several ids, and its two price columns belong to different ids: the sentence says
// which, e.g. "Models: `muse-spark-1.3`, `muse-spark-1.2`, and `muse-spark-1.1` in Standard mode;
// `muse-spark-1.3-contributor` and `muse-spark-1.2-contributor` in Contributor mode." A sentence with
// no mode ("Model: `muse-wonder-1.0`.") is Standard mode, and its Contributor column must then read
// "Not available". A Standard-only model priced by request length (Muse Ember) has instead two tier
// columns, "Up to 200K input tokens (per 1M tokens)" and "Over 200K input tokens (per 1M tokens)"; a
// request over the threshold is billed at the second column in full, so it maps to tier2_cache_read /
// tier2_input / tier2_output. Every column is read by its header label; an unknown column, row label or cell
// throws rather than shifting a price onto the wrong id.
//
// Muse Image (per image), Muse Voice Transcribe (per hour of audio) and SAM (per image / video
// frame) share the page but are not per-token; they are KNOWN_UNTRACKED. Every backticked API model
// id on the page (the rate-limit table lists them all) that is neither tracked nor excluded becomes
// an untracked_model notice. Muse Spark Open and Muse Glimmer are open weights with no Meta price.
//
// Meta-hosted models only. The Llama records under `meta-llama` are Together AI reference-host
// history and are not read here.

import { fetchText } from '../lib.mjs';

export const PROVIDER = 'meta';
const SOURCE_URL = 'https://dev.meta.ai/docs/pricing-rate-limits';
const FETCH_URL = `${SOURCE_URL}.md`;

// Meta's id -> aliases we carry. OpenRouter lists Muse Wonder as `meta/muse-wonder` and Muse Ember as
// `meta/muse-ember`.
const ID_TO_ALIASES = {
	'muse-spark-1.1': undefined,
	'muse-spark-1.2': undefined,
	'muse-spark-1.3': undefined,
	'muse-spark-1.2-contributor': undefined,
	'muse-spark-1.3-contributor': undefined,
	'muse-wonder-1.0': ['muse-wonder'],
	'muse-ember-1.0': ['muse-ember'],
};

// Every id we publish as current; collect() throws if one is not parsed.
const TRACKED = new Set(Object.keys(ID_TO_ALIASES));

// On the page, deliberately untracked, with the reason.
const KNOWN_UNTRACKED = {
	'muse-image-1.0': 'billed per generated image ($0.01), not per token',
	'muse-voice-transcribe-1.0': 'billed per hour of audio processed, not per token',
	'sam-3.1': 'billed per 1,000 images or video frames segmented, not per token',
};

const ROW_TO_VARIATION = {
	'cached input': 'cache_read',
	input: 'input',
	output: 'output',
};

const API_ID_RE = /`((?:muse|sam)-[a-z0-9][a-z0-9.-]*)`/g;

let notices = [];

/** Read by run.mjs after a successful collect(); see tools/sentinel/README.md. */
export function getNotices() {
	return notices;
}

function splitRow(line) {
	return line
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((c) => c.trim());
}

/** "$1.25" -> 1.25, "Not available" -> null, anything else throws. */
function parseCell(cell, where) {
	if (/^not available$/i.test(cell)) return null;
	const m = cell.match(/^\$\s*([0-9]+(?:\.[0-9]+)?)$/);
	if (!m) throw new Error(`meta collector: unreadable price cell "${cell}" in ${where}. Refusing to guess.`);
	return parseFloat(m[1]);
}

/** Map the model-id sentence to { standard: [...ids], contributor: [...ids] }. */
function idsByMode(sentence, section) {
	const out = { standard: [], contributor: [] };
	for (const clause of sentence.split(';')) {
		const ids = [...clause.matchAll(API_ID_RE)].map((m) => m[1]);
		if (!ids.length) continue;
		const contributor = /in contributor mode/i.test(clause);
		const standard = /in standard mode/i.test(clause) || !/\bmode\b/i.test(clause);
		if (contributor === standard)
			throw new Error(
				`meta collector: cannot tell which pricing mode "${clause.trim()}" names in "${section}". Refusing to guess.`
			);
		out[contributor ? 'contributor' : 'standard'].push(...ids);
	}
	return out;
}

function parseSection(name, body) {
	const lines = body.split('\n');
	const tableStart = lines.findIndex((l) => l.trim().startsWith('|'));
	if (tableStart < 0) return null;
	const header = splitRow(lines[tableStart]).map((c) => c.toLowerCase());
	if (!header.some((c) => c.includes('per 1m tokens'))) return null;

	if (header[0] !== 'usage')
		throw new Error(`meta collector: "${name}" table starts with "${header[0]}", expected "Usage".`);
	// Columns are either pricing modes (Standard / Contributor) or, for a model priced by request
	// length, two input-token tiers of Standard mode ("Up to 200K ..." / "Over 200K ..."). A request
	// over the threshold is billed at the second column in full, which is what tier2_* means.
	const cols = {};
	const thresholds = new Set();
	header.slice(1).forEach((label, i) => {
		let key = /^standard mode \(per 1m tokens\)$/.test(label)
			? 'standard'
			: /^contributor mode \(per 1m tokens\)$/.test(label)
				? 'contributor'
				: null;
		const tier = label.match(/^(up to|over) ([0-9]+k) input tokens \(per 1m tokens\)$/);
		if (tier) {
			key = tier[1] === 'up to' ? 'tier1' : 'tier2';
			thresholds.add(tier[2]);
		}
		if (!key) throw new Error(`meta collector: unknown column "${label}" in the "${name}" table. Refusing to guess.`);
		if (cols[key]) throw new Error(`meta collector: duplicate "${label}" column in the "${name}" table.`);
		cols[key] = i + 1;
	});
	const tiered = Boolean(cols.tier1 || cols.tier2);
	if (tiered && (!cols.tier1 || !cols.tier2 || cols.standard || cols.contributor || thresholds.size !== 1))
		throw new Error(
			`meta collector: "${name}" table mixes or half-states its input-token tier columns. Refusing to guess.`
		);
	if (!tiered && !cols.standard) throw new Error(`meta collector: "${name}" table has no Standard mode column.`);

	const ids = idsByMode(lines.slice(0, tableStart).join(' '), name);
	if (!ids.standard.length) throw new Error(`meta collector: no Standard-mode model id found for "${name}".`);
	if (ids.standard.some((id) => id.endsWith('-contributor')))
		throw new Error(`meta collector: a -contributor id is listed under Standard mode in "${name}".`);
	if (tiered && ids.contributor.length)
		throw new Error(`meta collector: "${name}" has tier columns but names Contributor-mode ids.`);

	const prices = { standard: {}, contributor: {} };
	for (const line of lines.slice(tableStart + 1)) {
		if (!line.trim().startsWith('|')) break;
		const cells = splitRow(line);
		if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
		const variation = ROW_TO_VARIATION[cells[0].toLowerCase()];
		if (!variation) throw new Error(`meta collector: unknown row "${cells[0]}" in the "${name}" table.`);
		for (const [key, idx] of Object.entries(cols)) {
			const v = parseCell(cells[idx] ?? '', `"${name}" ${cells[0]} / ${key}`);
			if (v === null) continue;
			if (key === 'tier1') prices.standard[variation] = v;
			else if (key === 'tier2') prices.standard[`tier2_${variation}`] = v;
			else prices[key][variation] = v;
		}
	}
	if (tiered && !('tier2_input' in prices.standard && 'tier2_output' in prices.standard))
		throw new Error(`meta collector: "${name}" long-context tier lacks an Input or Output price.`);

	for (const mode of ['standard', 'contributor']) {
		const priced = Object.keys(prices[mode]).length > 0;
		if (priced && !ids[mode].length)
			throw new Error(`meta collector: "${name}" prices ${mode} mode but names no ${mode}-mode model id.`);
		if (!priced && ids[mode].length)
			throw new Error(`meta collector: "${name}" names ${mode}-mode ids [${ids[mode].join(', ')}] but prices none.`);
		if (priced && !('input' in prices[mode] && 'output' in prices[mode]))
			throw new Error(`meta collector: "${name}" ${mode} mode lacks an Input or Output row.`);
	}
	return { ids, prices };
}

/**
 * Collect Meta Model API per-token prices.
 * Returns array of { provider, model_id, display_name, aliases?, prices, unit, source_url,
 *                    source_kind, confidence, known_mapping }. Fails loud on structural drift.
 */
export async function collect() {
	const md = await fetchText(FETCH_URL);
	notices = [];

	const sec = md.match(/^## Model pricing\s*$([\s\S]*?)(?=^## )/m);
	if (!sec) throw new Error('meta collector: "## Model pricing" section not found - structure drift.');
	// Long-context pricing is read only from a table's tier columns (Muse Ember). The page scopes its
	// "no long-context premium" statement to the flat-priced lines; if that scope changes, a tier may
	// exist that no table shows.
	if (!/no long-context premium on muse wonder and muse spark/i.test(sec[1]))
		throw new Error(
			'meta collector: the page no longer states "No long-context premium on Muse Wonder and Muse Spark". ' +
				'A long-context tier may now exist that this collector does not read. Human review required.'
		);

	const byModel = new Map();
	for (const part of sec[1].split(/^### /m).slice(1)) {
		const nl = part.indexOf('\n');
		const name = part.slice(0, nl).trim();
		const parsed = parseSection(name, part.slice(nl + 1));
		if (!parsed) continue;
		for (const mode of ['standard', 'contributor']) {
			for (const id of parsed.ids[mode]) {
				if (byModel.has(id)) throw new Error(`meta collector: "${id}" is priced twice on the page.`);
				byModel.set(id, { display: `${name} (${id})`, prices: { ...parsed.prices[mode] } });
			}
		}
	}
	if (!byModel.size) throw new Error('meta collector: found "## Model pricing" but parsed zero per-token models.');

	const pageIds = new Set([...md.matchAll(API_ID_RE)].map((m) => m[1]));
	for (const id of new Set([...byModel.keys(), ...pageIds])) {
		if (TRACKED.has(id) || KNOWN_UNTRACKED[id]) continue;
		const priced = byModel.get(id);
		notices.push({
			kind: 'untracked_model',
			provider: PROVIDER,
			model_id: id,
			display_name: id,
			source_url: SOURCE_URL,
			message:
				`"${id}" appears on Meta's own pricing page ` +
				(priced
					? `(${Object.entries(priced.prices)
							.map(([v, p]) => `${v} $${p}`)
							.join(', ')} per 1M tokens) `
					: '(no per-token price parsed) ') +
				'but is not tracked. Add it to ID_TO_ALIASES to start recording it, or add it to ' +
				'KNOWN_UNTRACKED with a reason to keep ignoring it.',
		});
	}

	const results = [];
	for (const [model_id, { display, prices }] of byModel) {
		if (!TRACKED.has(model_id)) continue;
		const aliases = ID_TO_ALIASES[model_id];
		results.push({
			provider: PROVIDER,
			model_id,
			display_name: display,
			aliases: aliases && aliases.length ? aliases : undefined,
			prices,
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: true,
		});
	}

	const missing = [...TRACKED].filter((id) => !byModel.has(id));
	if (missing.length)
		throw new Error(
			`meta collector: tracked model(s) not parsed from the pricing page: ${missing.join(', ')}. ` +
				'Either the page drifted or the model left the page (record the retirement and remove it from ' +
				'TRACKED). Refusing to report partial coverage as success.'
		);
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('meta collector failed:', e.message);
			process.exit(1);
		});
}
