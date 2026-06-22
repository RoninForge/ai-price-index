// tools/sentinel/collectors/alibaba.mjs  (MIT)
// First-party Alibaba (Qwen / Model Studio) price collector.
//
// Source: https://www.alibabacloud.com/help/en/model-studio/models  - server-rendered, real <table>s.
//
// The page is large and irregular. It is organized as:
//   H3 <Model family>            e.g. "Qwen-Max", "Qwen-Plus", "Qwen-Flash", "Qwen-Turbo", "Qwen-Coder"
//     H4 <Deployment region>     "International" | "Global" | "US" | "Chinese Mainland" | "China (Hong Kong)" | "EU"
//       (optional) H5 <series>   e.g. "Qwen3.5-Plus", "Qwen-Plus", "qwen3-coder-plus series"
//         <table(s)>
// The regions DISAGREE on price (EU Qwen-Plus output $2.40 vs US $1.20), so there is no single canonical
// price across the page. We anchor on the INTERNATIONAL deployment region - the canonical Alibaba intl
// USD tier, and the one the published dataset tracks. We IGNORE every other region's tables.
//
// Two distinct International table shapes carry prices:
//
//   (A) the per-region COMPARISON table (transposed: models are columns):
//         Flagship models            | Qwen3-Max ... | Qwen3.5-Plus ... | Qwen3.5-Flash ...
//         Max context window (tokens)| 262,144       | 1,000,000        | 1,000,000
//         Min input price (per 1M..) | $1.2          | $0.4             | $0.1
//         Min output price (per 1M..)| $6            | $2.4             | $0.4
//       "Min ... price" IS the base/lowest tier - exactly what we want. This is the authoritative source
//       for the three flagship models (qwen3-max, qwen3.5-plus, qwen3.5-flash).
//
//   (B) per-model TIERED band tables (input-length bands; take the FIRST/base band, the 0-... row):
//         Input tokens per request | [Mode] | Input cost (per 1M tokens) | Output cost (per 1M tokens)
//         0 < Tokens <= 256K       | ...    | $0.4                       | $2.4        <- BASE TIER
//         256K < Tokens <= 1M      | ...    | $0.5                       | $3
//       Some band tables have a "Mode" column (Thinking / Non-thinking); we take the NON-THINKING base row.
//
//   (C) per-model LIST tables (one row per snapshot; rowspan-heavy) for models that are NOT tiered and
//       NOT in the comparison table (qwen-max, qwen-turbo). Header carries "Input cost" / "Output cost".
//       We read the family STABLE row's Input/Output cost cells by matched header position. Output cells
//       may read "Thinking: $0.5 Non-thinking: $0.2" - we take the NON-THINKING (base) number.
//
// Units: the page mixes "per 1M tokens" and (historically) "per 1,000 tokens"; we normalize EVERY value
// to usd_per_mtok from the unit printed in the row/column label.
//
// FAIL LOUD: this collector throws if the International region, the comparison table, or ANY of the eight
// tracked models cannot be resolved from the live HTML, and it sanity-bounds every extracted price.
// It never emits a guessed number; a model genuinely absent from the page is reported as missing (thrown),
// not invented.

import { fetchText } from '../lib.mjs';

export const PROVIDER = 'alibaba';
const SOURCE_URL = 'https://www.alibabacloud.com/help/en/model-studio/models';

// The deployment-region heading we treat as the canonical intl USD tier.
const CANONICAL_REGION_RE = /^International\b/i;
// Region headings we recognize, so we can attribute each table to its region.
const REGION_HEADING_RE =
	/^(International|Global|US|Chinese mainland|China \(Hong Kong\)|EU|Singapore|Beijing)\b/i;

// The eight Qwen models the dataset tracks. Each spec says how to find its INTERNATIONAL base-tier price.
//   strategy "comparison" : read the per-region comparison table column whose name starts with `column`.
//   strategy "band"       : the first tiered band table inside H3 `section` (optionally gated by H5 `series`).
//   strategy "list"       : the STABLE row in the model-list table inside H3 `section` whose first token is `row`.
// `section` is matched against the nearest preceding H3; `series` (when present) against the nearest H5 that
// itself falls inside that H3 section (so a stale H5 from an earlier section cannot leak in).
const MODEL_SPECS = [
	{ model_id: 'qwen3-max', strategy: 'comparison', column: 'qwen3-max' },
	{ model_id: 'qwen3.5-plus', strategy: 'comparison', column: 'qwen3.5-plus' },
	{ model_id: 'qwen3.5-flash', strategy: 'comparison', column: 'qwen3.5-flash' },
	{ model_id: 'qwen3-coder-plus', strategy: 'band', section: 'Qwen-Coder', series: 'qwen3-coder-plus series' },
	{ model_id: 'qwen-plus', strategy: 'band', section: 'Qwen-Plus', series: 'Qwen-Plus' },
	{ model_id: 'qwen-flash', strategy: 'band', section: 'Qwen-Flash' },
	{ model_id: 'qwen-max', strategy: 'list', section: 'Qwen-Max', row: 'qwen-max' },
	{ model_id: 'qwen-turbo', strategy: 'list', section: 'Qwen-Turbo', row: 'qwen-turbo' },
];

// Sanity bounds (usd_per_mtok). Far wider than any plausible Qwen price; a value outside these means a
// parse/unit error, so we throw rather than emit it.
const PRICE_MIN = 0.001;
const PRICE_MAX = 1000;

function cleanCell(s) {
	return String(s)
		.replace(/<[^>]+>/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&#36;|&dollar;/g, '$')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&nbsp;/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/** First "$<number>" in a string -> number, or null. */
function parsePrice(s) {
	const m = String(s).match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
	if (!m) return null;
	const n = parseFloat(m[1]);
	return Number.isFinite(n) ? n : null;
}

/**
 * Parse an output-cost cell that may be mode-split, e.g. "Thinking: $0.5 Non-thinking: $0.2".
 * Returns the NON-THINKING (base) price when both are present, otherwise the single price found.
 */
function parseOutputPrice(s) {
	const str = String(s);
	const non = str.match(/non[-\s]?thinking\s*:?\s*\$\s*([0-9]+(?:\.[0-9]+)?)/i);
	if (non) return parseFloat(non[1]);
	return parsePrice(str);
}

// usd-per-?-tokens label -> multiplier to per-MTok. The page mixes "per 1M" and (historically) "per 1K".
function unitScaleFromLabel(label) {
	if (/per\s*1\s*m\s*tokens|per 1,000,000 tokens|per million tokens/i.test(label)) return 1;
	if (/per\s*1\s*k\s*tokens|per 1,000 tokens|per 1000 tokens/i.test(label)) return 1000;
	return null; // unknown unit -> caller decides (we never silently guess)
}

function rowsOf(tableHtml) {
	return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
		[...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cleanCell(m[1]))
	);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Collect Alibaba Qwen International-region base-tier prices for every tracked model.
 * Returns array of { provider, model_id, display_name, prices:{input,output}, unit, source_url,
 *                    source_kind, confidence, known_mapping, notes }. Fails loud on any structural drift.
 */
export async function collect() {
	const html = await fetchText(SOURCE_URL);

	// Ordered headings (with level) + ordered tables.
	const headings = [...html.matchAll(/<h([1-5])[^>]*>([\s\S]*?)<\/h[1-5]>/gi)].map((m) => ({
		level: Number(m[1]),
		text: cleanCell(m[2]),
		idx: m.index,
	}));
	const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => ({ html: m[0], idx: m.index }));
	if (!tables.length)
		throw new Error('alibaba collector: no <table> on the models page - JS-rendered or structure drift.');

	const sawInternational = headings.some((h) => CANONICAL_REGION_RE.test(h.text));
	if (!sawInternational)
		throw new Error('alibaba collector: no "International" deployment-region heading found - structure drift.');

	// Nearest preceding heading of a given level before a byte offset.
	const nearestHeading = (idx, level) => {
		let r = null;
		for (const h of headings) {
			if (h.idx >= idx) break;
			if (h.level === level) r = h;
		}
		return r;
	};
	// Nearest preceding region heading (any level) before a byte offset.
	const regionOf = (idx) => {
		let r = null;
		for (const h of headings) {
			if (h.idx >= idx) break;
			if (REGION_HEADING_RE.test(h.text)) r = h.text;
		}
		return r;
	};

	const isInternational = (idx) => CANONICAL_REGION_RE.test(regionOf(idx) || '');
	const intlTables = tables.filter((t) => isInternational(t.idx));
	if (!intlTables.length)
		throw new Error('alibaba collector: zero tables attributed to the International region - structure drift.');

	// ---- shape detection -----------------------------------------------------
	const isComparisonTable = (rows) => rows.some((r) => /^min input price/i.test(r[0] || ''));
	const isBandTable = (rows) => /^input tokens per request/i.test((rows[0] && rows[0][0]) || '');
	const isListTable = (rows) => {
		const h = (rows[0] || []).map((c) => c.toLowerCase());
		return (h[0] === 'model' || (h[0] || '').startsWith('model')) && h.some((c) => /input cost/.test(c));
	};

	// ---- (A) the International comparison table (flagship models as columns) --
	let comparison = null; // { byColumn: Map<lowerName, {input,output}> }
	for (const t of intlTables) {
		const rows = rowsOf(t.html);
		if (!isComparisonTable(rows)) continue;
		const header = rows[0] || [];
		const modelCols = header.slice(1).map((c) => (c || '').split(/\s/)[0].toLowerCase()); // first token per column
		const inputRow = rows.find((r) => /^min input price/i.test(r[0] || ''));
		const outputRow = rows.find((r) => /^min output price/i.test(r[0] || ''));
		if (!inputRow || !outputRow) continue;
		const inScale = unitScaleFromLabel(inputRow[0]);
		const outScale = unitScaleFromLabel(outputRow[0]);
		if (inScale === null || outScale === null) continue;

		const byColumn = new Map();
		modelCols.forEach((name, k) => {
			if (!name) return;
			const input = parsePrice(inputRow[k + 1]);
			const output = parsePrice(outputRow[k + 1]);
			if (input === null || output === null) return;
			byColumn.set(name, { input: round6(input * inScale), output: round6(output * outScale) });
		});
		comparison = { byColumn };
		break; // the first International comparison table is the flagship table
	}
	if (!comparison)
		throw new Error(
			'alibaba collector: International "Min input/output price" comparison table not found - structure drift. Refusing to guess.'
		);

	// ---- (B) International tiered band tables, bound to their H3 section + local H5 ---
	// bandTables: [{ section, series, first: {input, output} }]
	const bandTables = [];
	for (const t of intlTables) {
		const rows = rowsOf(t.html);
		if (!isBandTable(rows)) continue;
		const header = rows[0];
		const hasMode = header.some((c) => /^mode$/i.test(c));
		const inputColIdx = header.findIndex((c) => /input cost/i.test(c));
		const outputColIdx = header.findIndex((c) => /output cost/i.test(c));
		if (inputColIdx < 0 || outputColIdx < 0) continue;
		const inScale = unitScaleFromLabel(header[inputColIdx]);
		const outScale = unitScaleFromLabel(header[outputColIdx]);
		if (inScale === null || outScale === null) continue;

		// the BASE band is the first data row whose first cell starts with "0" (a "0 < Tokens <= ..." band).
		// for mode-split tables we want the NON-THINKING base row; we still read both prices off it.
		let baseRow = null;
		for (let i = 1; i < rows.length; i++) {
			const r = rows[i];
			if (!/^0\b/.test((r[0] || '').trim())) continue;
			if (hasMode) {
				const modeCell = (r[1] || '').toLowerCase();
				if (modeCell && !/non[-\s]?thinking/.test(modeCell)) continue; // skip the thinking variant of the base band
			}
			baseRow = r;
			break;
		}
		if (!baseRow) continue;

		const input = parsePrice(baseRow[inputColIdx]);
		const output = parsePrice(baseRow[outputColIdx]);
		if (input === null || output === null) continue;

		const h3 = nearestHeading(t.idx, 3);
		const h5 = nearestHeading(t.idx, 5);
		// only treat the H5 as relevant if it lies inside this H3 section (after the H3 start)
		const series = h5 && h3 && h5.idx > h3.idx ? h5.text : null;
		bandTables.push({
			section: h3 ? h3.text : null,
			series,
			first: { input: round6(input * inScale), output: round6(output * outScale) },
		});
	}

	// ---- (C) International model-list tables, bound to their H3 section -------
	// listRows: [{ section, byModel: Map<firstTokenLower, {input, output}> }]
	const listTables = [];
	for (const t of intlTables) {
		const rows = rowsOf(t.html);
		if (!isListTable(rows)) continue;
		const header = rows[0];
		const inputColIdx = header.findIndex((c) => /input cost/i.test(c));
		const outputColIdx = header.findIndex((c) => /output cost/i.test(c));
		if (inputColIdx < 0 || outputColIdx < 0) continue;
		// unit lives in row 1 ("(tokens)" / "(per 1M tokens)") for these tables; default per-1M if present
		const unitRow = rows[1] || [];
		const unitLabel = unitRow.join(' ');
		const scale = unitScaleFromLabel(unitLabel) ?? 1; // these list tables are per-1M; default 1 if unstated

		const h3 = nearestHeading(t.idx, 3);
		const byModel = new Map();
		for (let i = 1; i < rows.length; i++) {
			const r = rows[i];
			const firstTok = (r[0] || '').split(/\s/)[0].toLowerCase();
			if (!firstTok.startsWith('qwen')) continue;
			const input = parsePrice(r[inputColIdx]);
			const output = parseOutputPrice(r[outputColIdx]);
			if (input === null || output === null) continue;
			if (byModel.has(firstTok)) continue; // first (stable) row wins
			byModel.set(firstTok, { input: round6(input * scale), output: round6(output * scale) });
		}
		listTables.push({ section: h3 ? h3.text : null, byModel });
	}

	// ---- resolve every tracked model from the right source ------------------
	const sectionEq = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();

	const results = [];
	const missing = [];
	for (const spec of MODEL_SPECS) {
		let prices = null;
		let where = '';

		if (spec.strategy === 'comparison') {
			prices = comparison.byColumn.get(spec.column.toLowerCase()) || null;
			where = `International comparison table, "${spec.column}" column (Min input/output = base tier)`;
		} else if (spec.strategy === 'band') {
			const candidates = bandTables.filter(
				(b) => sectionEq(b.section, spec.section) && (!spec.series || sectionEq(b.series, spec.series))
			);
			if (candidates.length) {
				prices = candidates[0].first;
				where = `International tiered band table, section "${spec.section}"${
					spec.series ? ` / "${spec.series}"` : ''
				}, base (0-...) band`;
			}
		} else if (spec.strategy === 'list') {
			// a section can hold several list tables (e.g. Qwen-Max lists qwen3-max AND qwen-max separately);
			// scan all list tables in the section for the requested row.
			for (const l of listTables) {
				if (!sectionEq(l.section, spec.section)) continue;
				const hit = l.byModel.get(spec.row.toLowerCase());
				if (hit) {
					prices = hit;
					break;
				}
			}
			where = `International model-list table, section "${spec.section}", row "${spec.row}" (Input/Output cost)`;
		}

		if (!prices) {
			missing.push(spec.model_id);
			continue;
		}
		// sanity-bound both numbers; a value outside means a parse/unit error - fail loud.
		for (const [k, v] of Object.entries(prices)) {
			if (typeof v !== 'number' || !Number.isFinite(v) || v < PRICE_MIN || v > PRICE_MAX)
				throw new Error(
					`alibaba collector: ${spec.model_id} ${k}=${v} out of sanity bounds [${PRICE_MIN}, ${PRICE_MAX}] (read from ${where}). Refusing to emit.`
				);
		}

		results.push({
			provider: PROVIDER,
			model_id: spec.model_id,
			display_name: spec.model_id,
			prices: { input: prices.input, output: prices.output },
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: true,
			notes: `International deployment region (intl USD), Model Studio; base/standard tier. Read from ${where}.`,
		});
	}

	if (missing.length)
		throw new Error(
			`alibaba collector: could not resolve ${missing.length} tracked model(s) from the live page: ${missing.join(
				', '
			)}. The page changed or these models were removed - refusing to guess. Verify ${SOURCE_URL}.`
		);

	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('alibaba collector failed:', e.message);
			process.exit(1);
		});
}
