// tools/sentinel/collectors/alibaba.mjs  (MIT)
// First-party, KEYLESS Alibaba (Qwen / Model Studio) price collector.
//
// SOURCE CHANGED 2026-06-28 (structure drift fix). alibabacloud.com/help is now a client-rendered React
// SPA (aliyun "help-portal-fe"); the old server-rendered pricing tables on /model-studio/models are gone
// (that page is now a capabilities overview with NO prices and NO <table>s - the cause of the old
// "no <table> ... JS-rendered or structure drift" error). The SPA fetches each doc body from a KEYLESS
// JSON content API:
//     GET https://www.alibabacloud.com/help/json/document_detail.json?nodeId=<id>&website=intl&language=en
//     -> { code, success, data: { content: "<the doc body as HTML>", docTitle, ... } }
// `website=intl` is REQUIRED: website=en returns an empty body; only `intl` yields the international USD doc.
//
// Pricing now lives in its OWN doc, "Model inference pricing" (/model-studio/model-pricing, nodeId 2987148),
// whose HTML body carries per-model tables shaped:
//   Model ID | Deployment scope | Mode | Input tokens per request | Input price (per 1 million tokens) |
//   Output price (per 1 million tokens) | [Free quota]
// The same model is priced once per Deployment scope (International / Chinese mainland / Global / Hong Kong
// (China)); the scopes DISAGREE, so there is no single canonical number. We anchor on the INTERNATIONAL
// scope - the canonical intl USD tier the published dataset tracks - and take the BASE tier (the first
// "0 Token<=..." input band, or "No tiered pricing" for flat-priced models). Prices are already USD per 1M
// tokens, so usd_per_mtok directly (the input-price column header is unit-guarded to say "per 1 million
// tokens"; a table whose price column is in any other unit is skipped, never mis-scaled).
//
// Validated 2026-06-28: the 8 previously-tracked models read identical prices to the live dataset
// (qwen3-max $1.2/$6, qwen-max $1.6/$6.4, qwen-plus $0.4/$1.2, qwen-flash $0.05/$0.4, qwen-turbo $0.05/$0.2,
// qwen3.5-plus $0.4/$2.4, qwen3.5-flash $0.1/$0.4, qwen3-coder-plus $1/$5), confirming the scope/band choice.
// Four new flagships are now also tracked (qwen3.6-flash, qwen3.6-plus, qwen3.7-max, qwen3.7-plus); the
// sentinel drafts them as NEW for human verification before publish.
//
// FAIL LOUD on structural drift: throws if the content API returns no body, the doc has no <table>, the
// "International" scope is absent, or ZERO tracked models resolve. A handful of individually-missing tracked
// models are reported (not invented, not thrown) so one removed model never kills the rest of the run.
//
// Contract (same as the other collectors): an array of
//   { provider:"alibaba", model_id, display_name, prices:{ input, output } (usd_per_mtok),
//     unit:"usd_per_mtok", source_url, source_kind:"provider_live", confidence:"verified", known_mapping }

import { fetchJson } from '../lib.mjs';

export const PROVIDER = 'alibaba';

// The keyless help content API for the "Model inference pricing" doc. SOURCE_URL is the human-citable page
// the doc renders as (used as the records' source_url); the API is what we actually fetch.
const PRICING_NODE_ID = '2987148';
const CONTENT_API = `https://www.alibabacloud.com/help/json/document_detail.json?nodeId=${PRICING_NODE_ID}&website=intl&language=en`;
const SOURCE_URL = 'https://www.alibabacloud.com/help/en/model-studio/model-pricing';

// The Qwen flagship/mainline models the dataset tracks. Matched against the FIRST whitespace-delimited
// token of the "Model ID" cell, so dated snapshots (qwen3.7-max-2026-05-20) and look-alikes
// (qwen-plus-character) never match. Third-party models Bailian also hosts (glm-*, deepseek-*) are
// intentionally excluded - they belong to their own providers, not alibaba.
const TRACKED = [
	'qwen3-max',
	'qwen3.5-plus',
	'qwen3.5-flash',
	'qwen3-coder-plus',
	'qwen-plus',
	'qwen-flash',
	'qwen-max',
	'qwen-turbo',
	// New flagships surfaced by the tripwire, now first-party-priced from this doc:
	'qwen3.6-flash',
	'qwen3.6-plus',
	'qwen3.7-max',
	'qwen3.7-plus',
];

// Sanity bounds (usd_per_mtok). Far wider than any plausible Qwen price; outside means a parse/unit error.
const PRICE_MIN = 0.001;
const PRICE_MAX = 1000;

const CANONICAL_SCOPE_RE = /^International\b/i;

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

/** True when the input-price column header declares a per-1M-token unit (so the value is usd_per_mtok). */
function isPerMtokHeader(label) {
	return /per\s*1\s*(?:million|m)\s*tokens|per\s*1,?0{3},?0{3}\s*tokens/i.test(String(label));
}

/** A row's "Input tokens per request" cell marks the BASE tier when it is the lowest band or untiered. */
function isBaseBand(cell) {
	const b = String(cell || '')
		.replace(/\s+/g, '')
		.toLowerCase();
	if (b === '') return true; // no band column on this table -> the single row IS the base
	if (b.startsWith('0')) return true; // "0Token<=1M" etc. (the first/lowest band)
	if (b.includes('notiered')) return true; // "No tiered pricing"
	return false;
}

function rowsOf(tableHtml) {
	return [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
		[...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => cleanCell(m[1]))
	);
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Collect Alibaba Qwen International-scope base-tier prices for every tracked model.
 * Returns an array of { provider, model_id, display_name, prices:{input,output}, unit, source_url,
 * source_kind, confidence, known_mapping, notes }. Throws on structural drift; reports missing models.
 */
export async function collect() {
	const doc = await fetchJson(CONTENT_API);
	const content = doc && doc.data && doc.data.content;
	if (!content || typeof content !== 'string')
		throw new Error(
			`alibaba collector: content API returned no doc body (nodeId ${PRICING_NODE_ID}, website=intl). The help content API or the pricing doc id changed. Verify ${SOURCE_URL}.`
		);

	const tables = [...content.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
	if (!tables.length)
		throw new Error('alibaba collector: model-pricing doc body has no <table> - structure drift.');
	if (!/International/.test(content))
		throw new Error('alibaba collector: no "International" deployment scope in the pricing doc - structure/region drift.');

	const found = new Map(); // model_id -> { input, output }
	for (const t of tables) {
		const rows = rowsOf(t);
		if (rows.length < 2) continue;
		const header = rows[0].map((c) => c.toLowerCase());
		const scopeCol = header.findIndex((c) => /deployment scope/.test(c));
		const inCol = header.findIndex((c) => /input price/.test(c));
		const outCol = header.findIndex((c) => /output price/.test(c));
		const bandCol = header.findIndex((c) => /input tokens per request/.test(c));
		if (scopeCol < 0 || inCol < 0 || outCol < 0) continue;
		// Unit guard: only parse tables whose price columns are per-1M-token (skip per-image/-second/etc.).
		if (!isPerMtokHeader(rows[0][inCol])) continue;

		for (let i = 1; i < rows.length; i++) {
			const r = rows[i];
			const id = (r[0] || '').trim().split(/\s+/)[0].toLowerCase();
			if (!TRACKED.includes(id)) continue;
			if (found.has(id)) continue; // first International base row (in doc order) wins
			if (!CANONICAL_SCOPE_RE.test((r[scopeCol] || '').trim())) continue;
			if (bandCol >= 0 && !isBaseBand(r[bandCol])) continue;
			const input = parsePrice(r[inCol]);
			const output = parsePrice(r[outCol]);
			if (input === null || output === null) continue;
			found.set(id, { input: round6(input), output: round6(output) });
		}
	}

	if (!found.size)
		throw new Error(
			'alibaba collector: parsed the pricing doc but resolved ZERO tracked International prices - structure drift. Refusing to guess.'
		);

	const results = [];
	for (const model_id of TRACKED) {
		const prices = found.get(model_id);
		if (!prices) continue; // missing -> reported by the CLI/run layer, never invented
		for (const [k, v] of Object.entries(prices)) {
			if (typeof v !== 'number' || !Number.isFinite(v) || v < PRICE_MIN || v > PRICE_MAX)
				throw new Error(
					`alibaba collector: ${model_id} ${k}=${v} out of sanity bounds [${PRICE_MIN}, ${PRICE_MAX}]. Refusing to emit.`
				);
		}
		results.push({
			provider: PROVIDER,
			model_id,
			display_name: model_id,
			prices: { input: prices.input, output: prices.output },
			unit: 'usd_per_mtok',
			source_url: SOURCE_URL,
			source_kind: 'provider_live',
			confidence: 'verified',
			known_mapping: true,
			notes: 'International deployment scope (intl USD), Model Studio "Model inference pricing"; base/standard tier.',
		});
	}
	return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	collect()
		.then((rows) => {
			const found = new Set(rows.map((r) => r.model_id));
			const missing = TRACKED.filter((id) => !found.has(id));
			console.log(JSON.stringify(rows, null, 2));
			if (missing.length) console.error('tracked-but-missing (omitted, not invented):', missing.join(', '));
		})
		.catch((e) => {
			console.error('alibaba collector failed:', e.message);
			process.exit(1);
		});
}
