// tools/sentinel/tripwire.mjs  (MIT)
// Keyless "tripwire" surfaces that cheaply tell us a mainstream model is NEW or its
// reseller price MOVED, so the (slower, careful) first-party collectors know where to look.
//
//   * OpenRouter   GET /api/v1/models   -> id, canonical_slug, created, pricing{prompt,completion,...}
//                  RESELLER prices: used ONLY as a new/changed tripwire + sanity cross-check.
//   * HuggingFace  GET /api/models?author=<org>&sort=createdAt  -> recently published open weights.
//
// Output is advisory: a list of candidates mapped to OUR provider slugs, alias-aware vs current.
// Nothing here is ever written as a published price.

import { fetchJson, loadCurrent, toUsdPerMtok, classify } from './lib.mjs';

// OpenRouter prefixes its ids as "<vendor>/<model>". Map the vendor to our provider slug.
// Only these mainstream vendors are kept; everything else (reseller-only hosts, fine-tunes) is dropped.
const OPENROUTER_VENDOR_TO_PROVIDER = {
	anthropic: 'anthropic',
	openai: 'openai',
	google: 'google',
	'x-ai': 'xai',
	xai: 'xai',
	mistralai: 'mistral',
	mistral: 'mistral',
	deepseek: 'deepseek',
	amazon: 'amazon',
	'amazon-bedrock': 'amazon',
	cohere: 'cohere',
	qwen: 'alibaba',
	alibaba: 'alibaba',
	meta: 'meta-llama',
	'meta-llama': 'meta-llama',
};

// HuggingFace orgs whose freshly-published repos are a heads-up that a new open-weights
// flagship may be about to get a hosted price somewhere.
const HF_ORGS = [
	{ org: 'meta-llama', provider: 'meta-llama' },
	{ org: 'mistralai', provider: 'mistral' },
	{ org: 'deepseek-ai', provider: 'deepseek' },
	{ org: 'Qwen', provider: 'alibaba' },
];

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const HF_URL = (org) =>
	`https://huggingface.co/api/models?author=${encodeURIComponent(org)}&sort=createdAt&direction=-1&limit=20`;

// Drop obvious non-flagship noise so the tripwire stays an actionable signal, not a dump.
// Covers OpenRouter routing variants AND HuggingFace quantizations / research artifacts
// (GPTQ/AWQ/FP8/GGUF/bnb quants, SAE probes, base/bench/embedding repos, sub-billion params).
const NOISE_RE =
	/(free|preview|experimental|extended|online|:thinking|:batch|nitro|beta\b|fine-?tune|gptq|awq|gguf|fp8|int4|int8|bnb-|-mlx|sae-|-bench\b|-base\b|guard|embedding|reranker|whisper|deepseek-ocr|tts|asr)/i;

function unixToIsoDate(sec) {
	if (!Number.isFinite(sec)) return null;
	return new Date(sec * 1000).toISOString().slice(0, 10);
}

/** Map an OpenRouter id like "anthropic/claude-opus-4.8" -> { provider, bareId } or null if not mainstream. */
function mapOpenRouterId(id) {
	const slash = String(id).indexOf('/');
	if (slash < 0) return null;
	const vendor = id.slice(0, slash).toLowerCase();
	const provider = OPENROUTER_VENDOR_TO_PROVIDER[vendor];
	if (!provider) return null;
	// strip any ":variant" suffix from the model part for matching purposes
	const bareId = id.slice(slash + 1).split(':')[0];
	return { provider, bareId };
}

async function pollOpenRouter(current) {
	const data = await fetchJson(OPENROUTER_URL);
	const list = Array.isArray(data && data.data) ? data.data : [];
	const out = [];
	for (const m of list) {
		const mapped = mapOpenRouterId(m.id);
		if (!mapped) continue;
		const { provider, bareId } = mapped;
		if (NOISE_RE.test(m.id)) continue;

		// Reseller per-token prices -> usd_per_mtok, used only as a tripwire signal.
		const extracted = {};
		const p = m.pricing || {};
		const inp = toUsdPerMtok(p.prompt, 'per_token');
		const out_ = toUsdPerMtok(p.completion, 'per_token');
		if (inp !== null) extracted.input = inp;
		if (out_ !== null) extracted.output = out_;

		// Match against our slug using both the bare id and the canonical_slug's model part.
		const candidates = new Set([bareId]);
		if (typeof m.canonical_slug === 'string') {
			const cm = mapOpenRouterId(m.canonical_slug);
			if (cm) candidates.add(cm.bareId);
		}
		let status = 'NEW';
		let matchedOn = null;
		for (const c of candidates) {
			const s = classify(provider, c, extracted, current);
			if (s !== 'NEW') {
				status = s;
				matchedOn = c;
				break;
			}
		}
		// Only surface mainstream NEW or CHANGED; UNCHANGED reseller rows are noise.
		if (status === 'UNCHANGED') continue;

		out.push({
			source: 'openrouter',
			provider,
			source_id: m.id,
			bare_id: matchedOn || bareId,
			status, // NEW | CHANGED (reseller-priced; first-party must confirm)
			created: unixToIsoDate(m.created),
			reseller_input_usd_per_mtok: extracted.input ?? null,
			reseller_output_usd_per_mtok: extracted.output ?? null,
			note: status === 'CHANGED'
				? 'OpenRouter reseller price differs from our published price; confirm against first-party.'
				: 'Model not in our index; confirm it is a real first-party model before pricing.',
		});
	}
	return out;
}

async function pollHuggingFace(current) {
	const out = [];
	for (const { org, provider } of HF_ORGS) {
		const list = await fetchJson(HF_URL(org));
		if (!Array.isArray(list)) continue;
		for (const m of list) {
			const id = m.modelId || m.id; // "Qwen/Qwen3-..." etc
			if (typeof id !== 'string') continue;
			const bare = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
			if (NOISE_RE.test(bare)) continue;
			// HF only tells us a repo exists; treat anything not already known as a NEW open-weights heads-up.
			const status = classify(provider, bare, {}, current);
			if (status !== 'NEW') continue;
			out.push({
				source: 'huggingface',
				provider,
				source_id: id,
				bare_id: bare,
				status: 'NEW',
				created: typeof m.createdAt === 'string' ? m.createdAt.slice(0, 10) : null,
				note: 'New open-weights repo; no hosted price implied. Heads-up only.',
			});
		}
	}
	return out;
}

/**
 * Poll OpenRouter + the HF orgs and return mainstream NEW/CHANGED candidates, alias-aware vs current.
 * Per-source failures are swallowed into the result's `errors` so one dead surface does not kill the run.
 * Returns { candidates: [...], errors: [{ source, error }] }.
 */
export async function findCandidates({ current } = {}) {
	const cur = current || loadCurrent();
	const candidates = [];
	const errors = [];

	const tasks = [
		{ source: 'openrouter', run: () => pollOpenRouter(cur) },
		{ source: 'huggingface', run: () => pollHuggingFace(cur) },
	];

	for (const t of tasks) {
		try {
			candidates.push(...(await t.run()));
		} catch (e) {
			errors.push({ source: t.source, error: e.message });
		}
	}

	// stable, readable ordering: NEW first, then by provider/id
	candidates.sort((a, b) => {
		if (a.status !== b.status) return a.status === 'NEW' ? -1 : 1;
		return (a.provider + a.source_id).localeCompare(b.provider + b.source_id);
	});

	return { candidates, errors };
}

// standalone run: print the candidates as JSON
if (import.meta.url === `file://${process.argv[1]}`) {
	findCandidates()
		.then((r) => console.log(JSON.stringify(r, null, 2)))
		.catch((e) => {
			console.error('tripwire failed:', e.message);
			process.exit(1);
		});
}
