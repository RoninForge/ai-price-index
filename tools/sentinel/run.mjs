#!/usr/bin/env node
// tools/sentinel/run.mjs  (MIT)
// Price-sentinel orchestrator.
//
//   node tools/sentinel/run.mjs            # dry-run report (default; writes NOTHING)
//   node tools/sentinel/run.mjs --dry-run  # explicit; identical to the default
//   node tools/sentinel/run.mjs --json     # report as compact JSON only (still a dry-run)
//   node tools/sentinel/run.mjs --apply    # APPEND drafted NEW-model records into data/records/<provider>.json
//                                          #   + write sentinel-report.md (new models, suggested CHANGED edits, errors)
//
// It:
//   1. polls the keyless tripwires (OpenRouter + HuggingFace) for mainstream NEW/CHANGED candidates,
//   2. runs the first-party collectors via a small provider->collector registry,
//   3. diffs each collected model against the published current prices (alias-aware), and
//   4. reports:
//        { generated_at, mode, tripwire_candidates, new_models, price_changes, drafted_records, errors }
//      where drafted_records are FULL valid contribution-form records for NEW models (each built via
//      makeRecord, so an invalid one throws rather than being emitted). price_changes are LISTED only -
//      the sentinel NEVER auto-writes bitemporal edits for an existing model's price.
//
// --apply additionally:
//   * APPENDS the drafted NEW-model records into the matching data/records/<provider>.json (created as a
//     JSON array if missing), preserving 2-space indentation + a single trailing newline, and
//   * writes a human-readable sentinel-report.md (new models drafted, CHANGED prices as suggested edits,
//     and any errors / BLOCKED providers) for use as a PR body.
//   It does NOT edit existing records for CHANGED prices.
//
// Per-collector errors are caught into report.errors so one dead source (e.g. xai BLOCKED with no key,
// or a google scrape that drifts) never kills the run.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
	today,
	loadCurrent,
	classify,
	classifyUpgrade,
	makeRecord,
	effectiveFromForNew,
	REPO_ROOT,
	buildTrackedFamilyRoots,
	classifyPendingCandidate,
} from './lib.mjs';
import { findCandidates } from './tripwire.mjs';
import { crossCheck, buildOpenRouterLookup, normalizeModelKey } from './crosscheck.mjs';
import * as anthropic from './collectors/anthropic.mjs';
import * as llama from './collectors/llama.mjs';
import * as amazon from './collectors/amazon.mjs';
import * as mistral from './collectors/mistral.mjs';
import * as deepseek from './collectors/deepseek.mjs';
import * as google from './collectors/google.mjs';
import * as alibaba from './collectors/alibaba.mjs';
import * as xai from './collectors/xai.mjs';
import * as openai from './collectors/openai.mjs';
import * as cohere from './collectors/cohere.mjs';

// provider -> collector. Provider slugs MUST match what each collector emits AND our dataset:
// anthropic, meta-llama, amazon, mistral, deepseek, google, alibaba, xai, openai, cohere.
const COLLECTORS = [
	{ provider: 'anthropic', collect: anthropic.collect },
	{ provider: 'meta-llama', collect: llama.collect },
	{ provider: 'amazon', collect: amazon.collect },
	{ provider: 'mistral', collect: mistral.collect },
	{ provider: 'deepseek', collect: deepseek.collect },
	{ provider: 'google', collect: google.collect },
	{ provider: 'alibaba', collect: alibaba.collect },
	{ provider: 'xai', collect: xai.collect },
	{ provider: 'openai', collect: openai.collect },
	{ provider: 'cohere', collect: cohere.collect },
];

// Which extracted variations become contribution records (in this order).
const RECORD_VARIATIONS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

/**
 * Resolve a non-future effective_from for a NEW model. Delegates the date policy to lib's
 * effectiveFromForNew: a threaded tripwire discovery date (item.createdDate) when present + valid +
 * not-future, else today(). Kept as a thin wrapper so the threading site reads cleanly.
 */
function effectiveFromFor(item) {
	return effectiveFromForNew(item.createdDate, today());
}

/**
 * Turn one collected model into 1..N contribution-form records (NEW models only).
 * `confidenceOverride` (optional) replaces item.confidence when the cross-check gate downgraded the
 * model to needs_review (e.g. 'inferred'); `notesPrefix` (optional) is prepended to notes so the
 * reasons travel with the drafted record into the PR.
 */
function draftRecordsFor(item, { confidenceOverride, notesPrefix } = {}) {
	const recs = [];
	const effective_from = effectiveFromFor(item);
	const confidence = confidenceOverride || item.confidence;
	let notes = item.notes;
	if (notesPrefix) notes = notes ? `${notesPrefix} ${notes}` : notesPrefix;
	for (const variation of RECORD_VARIATIONS) {
		const price = item.prices[variation];
		if (typeof price !== 'number') continue;
		recs.push(
			makeRecord({
				provider: item.provider,
				model_id: item.model_id,
				variation,
				unit: item.unit,
				price_usd: price,
				effective_from,
				effective_to: null,
				last_validated_at: today(),
				source_url: item.source_url,
				source_kind: item.source_kind,
				confidence,
				aliases: item.aliases,
				notes,
			})
		);
	}
	return recs;
}

/**
 * Build an index of tripwire candidates that carry a discovery date, keyed by "provider/id".
 * OpenRouter rows carry `created` (already an ISO date in tripwire output) and a `bare_id`/`source_id`;
 * HuggingFace rows carry `created` too. We key on every id form we can so a collector's model_id or an
 * alias can match. Used only to refine effective_from for NEW models.
 */
function indexTripwireDates(candidates) {
	const byKey = new Map(); // "provider/id" -> ISO date
	for (const c of candidates || []) {
		const date = typeof c.created === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.created) ? c.created : null;
		if (!date) continue;
		const ids = new Set();
		if (c.bare_id) ids.add(c.bare_id);
		if (typeof c.source_id === 'string') {
			ids.add(c.source_id);
			const slash = c.source_id.indexOf('/');
			if (slash >= 0) ids.add(c.source_id.slice(slash + 1).split(':')[0]);
		}
		for (const id of ids) {
			const key = `${c.provider}/${id}`;
			// keep the earliest known date if several candidates collide on a key
			if (!byKey.has(key) || date < byKey.get(key)) byKey.set(key, date);
		}
	}
	return byKey;
}

/** Look up a discovery date for a collected NEW model from the tripwire date index (model_id or alias). */
function tripwireCreatedDate(item, dateIndex) {
	const tries = [item.model_id, ...(Array.isArray(item.aliases) ? item.aliases : [])];
	for (const id of tries) {
		const d = dateIndex.get(`${item.provider}/${id}`);
		if (d) return d;
	}
	return null;
}

/** Path to data/records/<provider>.json (provider slug == file name). */
function recordsPathFor(provider) {
	return join(REPO_ROOT, 'data', 'records', `${provider}.json`);
}

/**
 * Append drafted records into data/records/<provider>.json, grouped by provider. Creates the file as a
 * JSON array if it does not exist. Preserves 2-space indentation + a single trailing newline, exactly
 * like pricing-audit.yml's append step (json.dump(records, f, indent=2); f.write("\n")).
 * Returns [{ provider, file, added }].
 */
function applyDraftedRecords(drafted) {
	const byProvider = new Map();
	for (const rec of drafted) {
		if (!byProvider.has(rec.provider)) byProvider.set(rec.provider, []);
		byProvider.get(rec.provider).push(rec);
	}
	const written = [];
	for (const [provider, recs] of byProvider) {
		const path = recordsPathFor(provider);
		let existing = [];
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, 'utf8'));
			if (!Array.isArray(parsed)) throw new Error(`${path} is not a JSON array; refusing to append.`);
			existing = parsed;
		}
		existing.push(...recs);
		writeFileSync(path, JSON.stringify(existing, null, 2) + '\n');
		written.push({ provider, file: join('data', 'records', `${provider}.json`), added: recs.length });
	}
	return written;
}

/** Render the human-readable sentinel-report.md used as the PR body. */
function renderReportMd(report, written) {
	const L = [];
	L.push('# Price Sentinel report');
	L.push('');
	L.push(`Generated ${report.generated_at} by \`.github/workflows/price-sentinel.yml\` (\`node tools/sentinel/run.mjs --apply\`).`);
	L.push('');
	L.push(
		`Summary: ${report.new_models.length} new model(s), ${report.price_changes.length} price change(s), ` +
			`${report.upgrades.length} provenance upgrade(s), ${report.pending_first_party.length} detected awaiting ` +
			`first-party price (${report.pending_filtered_out} variant/open-weight SKUs filtered out), ` +
			`${report.tripwire_candidates.length} tripwire candidate(s), ${report.errors.length} error(s).`
	);
	L.push('');

	// Cross-check gate: the correctness differentiator. Auto-verified items are safe to merge with a
	// glance; needs-review items are downgraded to `inferred` and listed with the reasons a human
	// should resolve before flipping them back to verified.
	const cc = report.crosscheck || { auto_verified: 0, needs_review: 0, items: [] };
	L.push('## Cross-check gate');
	L.push('');
	L.push(
		`The correctness gate ran on every NEW model and CHANGED price: ` +
			`${cc.auto_verified} auto-verified, ${cc.needs_review} need review.`
	);
	L.push('');
	const verifiedItems = cc.items.filter((i) => i.verdict === 'verified');
	const reviewItems = cc.items.filter((i) => i.verdict !== 'verified');

	L.push('### Auto-verified (safe to merge)');
	L.push('');
	if (verifiedItems.length) {
		L.push('Passed structural, change-magnitude, and aggregator cross-reference checks.');
		L.push('');
		L.push('| Provider | Model | Kind |');
		L.push('|---|---|---|');
		for (const i of verifiedItems) L.push(`| \`${i.provider}\` | \`${i.model_id}\` | ${i.kind} |`);
		L.push('');
	} else {
		L.push('None.');
		L.push('');
	}

	L.push('### Needs review (reasons)');
	L.push('');
	if (reviewItems.length) {
		L.push(
			'Downgraded to `inferred` until a human resolves each reason and (where correct) flips it back ' +
				'to `verified`. NEW models here were drafted into JSON as `inferred`; CHANGED prices are ' +
				'suggested-only.'
		);
		L.push('');
		L.push('| Provider | Model | Kind | Reasons |');
		L.push('|---|---|---|---|');
		for (const i of reviewItems) {
			const reasons = (i.reasons || []).join('; ').replace(/\|/g, '\\|');
			L.push(`| \`${i.provider}\` | \`${i.model_id}\` | ${i.kind} | ${reasons} |`);
		}
		L.push('');
	} else {
		L.push('None.');
		L.push('');
	}

	// New models (drafted into JSON in this PR)
	if (report.new_models.length) {
		L.push('## New models drafted');
		L.push('');
		if (written.length) {
			L.push(
				'Full contribution-form record(s) have been appended to: ' +
					written.map((w) => `\`${w.file}\` (+${w.added})`).join(', ') +
					'. Verify each first-party field and flip `confidence` where needed before merge.'
			);
			L.push('');
		}
		L.push('| Provider | Model | Prices (per MTok) | Confidence | Source kind |');
		L.push('|---|---|---|---|---|');
		for (const nm of report.new_models) {
			const prices = Object.entries(nm.prices)
				.map(([k, v]) => `${k} $${v}`)
				.join(', ');
			L.push(`| \`${nm.provider}\` | \`${nm.model_id}\` | ${prices} | ${nm.confidence} | ${nm.source_kind} |`);
		}
		L.push('');
	} else {
		L.push('## New models drafted');
		L.push('');
		L.push('None.');
		L.push('');
	}

	// Provenance upgrades (now first-party-confirmed) - drafted as verified records to supersede
	// the prior weaker (inferred/estimated, or aggregator/changelog/manual) record at the SAME price.
	L.push('## Provenance upgrades (now first-party-confirmed)');
	L.push('');
	if (report.upgrades.length) {
		L.push(
			'A first-party collector confirmed the published price for a model we held at WEAKER provenance. ' +
				'A stronger `verified` / `provider_live` record has been drafted to SUPERSEDE the prior record ' +
				'(same price, better provenance). Close the prior open interval per CONTRIBUTING when merging.'
		);
		L.push('');
		L.push('| Provider | Model | From | To | Cross-check |');
		L.push('|---|---|---|---|---|');
		for (const u of report.upgrades) {
			const from = `${u.from.confidence || '-'} / ${u.from.source_kind || '-'}`;
			const to = `${u.to.confidence || '-'} / ${u.to.source_kind || '-'}`;
			const cc = u.crosscheck && u.crosscheck.verdict === 'needs_review' ? 'needs review' : 'verified';
			L.push(`| \`${u.provider}\` | \`${u.model_id}\` | ${from} | ${to} | ${cc} |`);
		}
		L.push('');
	} else {
		L.push('None.');
		L.push('');
	}

	// Detected, awaiting first-party price (Part B). NOT published - first-party-pure.
	// Scoped to GENUINELY-NEW model families: the long tail of open-weight size/quant SKUs and
	// dated/variant snapshots of tracked families is filtered out (report.pending_filtered_out).
	L.push('## Detected, awaiting first-party price (not published)');
	L.push('');
	const filteredOut = report.pending_filtered_out || 0;
	const filteredNote = filteredOut ? ` (${filteredOut} variant/open-weight SKUs filtered out)` : '';
	if (report.pending_first_party.length) {
		L.push(
			'A tripwire (OpenRouter / HuggingFace) detected a GENUINELY-NEW model family from a core lab that NO ' +
				'first-party collector surfaced this run - announced but not yet on the provider\'s own pricing page. ' +
				'We do NOT draft a price (a reseller number would break the first-party pledge). The OpenRouter price ' +
				'is a HINT for the human only and is NOT written to the dataset. Long-tail size/quant variants and ' +
				`snapshots of families we already track are filtered out${filteredNote}.`
		);
		L.push('');
		L.push('| Provider | Model | Detected | Source | OpenRouter price HINT (not published) |');
		L.push('|---|---|---|---|---|');
		const PENDING_RENDER_CAP = 25;
		const shown = report.pending_first_party.slice(0, PENDING_RENDER_CAP);
		for (const p of shown) {
			const hint = p.openrouter_price_hint
				? `in $${p.openrouter_price_hint.input ?? '-'}, out $${p.openrouter_price_hint.output ?? '-'}`
				: 'none';
			L.push(`| \`${p.provider}\` | \`${p.model_id}\` | ${p.detected_date || '-'} | ${p.source} | ${hint} |`);
		}
		const remaining = report.pending_first_party.length - shown.length;
		if (remaining > 0) L.push(`| | +${remaining} more | | | |`);
		L.push('');
	} else {
		L.push(`None${filteredNote}.`);
		L.push('');
	}

	// Price changes (suggested edits ONLY - never auto-written)
	L.push('## Price changes (suggested edits, NOT auto-written)');
	L.push('');
	if (report.price_changes.length) {
		L.push(
			'A first-party price for a model we already publish differs from `current.json`. These are SUGGESTED ' +
				'bitemporal interval edits - the sentinel does NOT auto-edit existing records (closing one interval ' +
				'and opening another is error-prone to generate). Verify each rate on the provider\'s own pricing ' +
				'page, then hand-edit the matching record(s) in `data/records/<provider>.json` per CONTRIBUTING.'
		);
		L.push('');
		L.push('| Provider | Model | Variation | From | To | Confidence | Source |');
		L.push('|---|---|---|---|---|---|---|');
		for (const pc of report.price_changes) {
			for (const [variation, d] of Object.entries(pc.changes)) {
				L.push(
					`| \`${pc.provider}\` | \`${pc.model_id}\` | ${variation} | $${d.from} | $${d.to} | ` +
						`${pc.confidence} | ${pc.source_kind} |`
				);
			}
		}
		L.push('');
	} else {
		L.push('None.');
		L.push('');
	}

	// Errors + BLOCKED providers
	L.push('## Errors and BLOCKED providers');
	L.push('');
	if (report.errors.length) {
		L.push('One dead source never kills the run; these are surfaced for visibility (e.g. xAI is BLOCKED without a key).');
		L.push('');
		L.push('| Stage | Provider/Source | Error |');
		L.push('|---|---|---|');
		for (const e of report.errors) {
			const who = e.provider || e.source || '-';
			const msg = String(e.error || '').replace(/\|/g, '\\|');
			L.push(`| ${e.stage} | \`${who}\` | ${msg} |`);
		}
		L.push('');
	} else {
		L.push('None.');
		L.push('');
	}

	// Tripwire (advisory)
	if (report.tripwire_candidates.length) {
		L.push('## Tripwire candidates (advisory)');
		L.push('');
		L.push('Keyless OpenRouter + HuggingFace signals that a mainstream model may be new or its reseller price moved. Advisory only; never published.');
		L.push('');
		L.push('| Source | Provider | Id | Status | Created |');
		L.push('|---|---|---|---|---|');
		for (const c of report.tripwire_candidates) {
			L.push(`| ${c.source} | \`${c.provider}\` | \`${c.source_id}\` | ${c.status} | ${c.created || '-'} |`);
		}
		L.push('');
	}

	L.push('---');
	L.push('');
	L.push(
		'`validate.yml` runs on this PR and is EXPECTED to be red until a human verifies the drafted ' +
			'first-party fields. That red CI is the gate. Generated by the multi-provider first-party sentinel.'
	);
	L.push('');
	return L.join('\n');
}

async function main() {
	const args = process.argv.slice(2);
	const jsonOnly = args.includes('--json');
	const apply = args.includes('--apply');
	// dry-run is the DEFAULT. Anything that is not --apply is a dry-run (writes nothing).
	const dryRun = !apply;

	const current = loadCurrent();
	const report = {
		generated_at: today(),
		mode: apply ? 'apply' : 'dry-run',
		tripwire_candidates: [],
		new_models: [],
		price_changes: [],
		upgrades: [],
		pending_first_party: [],
		pending_filtered_out: 0,
		drafted_records: [],
		crosscheck: { auto_verified: 0, needs_review: 0, items: [] },
		errors: [],
	};

	// 1. tripwire (advisory). Also feeds effective_from refinement for NEW models.
	try {
		const { candidates, errors } = await findCandidates({ current });
		report.tripwire_candidates = candidates;
		for (const e of errors) report.errors.push({ stage: 'tripwire', source: e.source, error: e.error });
	} catch (e) {
		report.errors.push({ stage: 'tripwire', error: e.message });
	}
	const tripwireDates = indexTripwireDates(report.tripwire_candidates);

	// Build the OpenRouter (reseller) price lookup from the tripwire data we ALREADY fetched above.
	// Do NOT re-fetch. crossCheck uses this as best-effort independent corroboration.
	const openrouter = buildOpenRouterLookup(report.tripwire_candidates);

	/**
	 * Run the cross-check gate for one candidate, fail-safe: any throw defaults the item to
	 * needs_review (we never publish-as-verified something the gate could not evaluate). The thrown
	 * message is surfaced as a reason + into report.errors. Records the verdict in report.crosscheck.
	 */
	const runGate = (candidate) => {
		let result;
		try {
			result = crossCheck(candidate, { openrouter });
			if (!result || (result.verdict !== 'verified' && result.verdict !== 'needs_review')) {
				throw new Error('crossCheck returned an invalid verdict');
			}
		} catch (e) {
			report.errors.push({ stage: 'crosscheck', provider: candidate.provider, model: candidate.model_id, error: e.message });
			result = { verdict: 'needs_review', reasons: [`cross-check threw, defaulting to needs_review: ${e.message}`] };
		}
		report.crosscheck.items.push({
			provider: candidate.provider,
			model_id: candidate.model_id,
			kind: candidate.isNew ? 'new' : 'changed',
			verdict: result.verdict,
			reasons: result.reasons,
		});
		if (result.verdict === 'verified') report.crosscheck.auto_verified++;
		else report.crosscheck.needs_review++;
		return result;
	};

	// Every normalized id form a first-party collector surfaced this run, scoped by provider, so Part B
	// can tell which tripwire NEW models are "announced but NOT yet on the provider's own pricing page".
	const collectorSeenKeys = new Set();
	const markCollectorSeen = (provider, ...ids) => {
		for (const id of ids) {
			const k = normalizeModelKey(id);
			if (k) collectorSeenKeys.add(`${provider}/${k}`);
		}
	};

	// 2 + 3. collectors + diff. Per-collector try/catch: one failing collector (xai BLOCKED with no key,
	// google drift, ...) lands in report.errors[] and never kills the run.
	for (const c of COLLECTORS) {
		let items;
		try {
			items = await c.collect();
		} catch (e) {
			report.errors.push({ stage: 'collector', provider: c.provider, error: e.message });
			continue;
		}
		for (const item of items) {
			// A model the first-party collector returned at all is "on the provider's own page"; record
			// every id form (model_id + aliases) so Part B excludes it from pending_first_party.
			markCollectorSeen(item.provider, item.model_id, ...(Array.isArray(item.aliases) ? item.aliases : []));

			// the collector's own provenance for this model, used by the UPGRADE check
			const incomingProvenance = { confidence: item.confidence, source_kind: item.source_kind };
			let status;
			try {
				status = classifyUpgrade(item.provider, item.model_id, item.prices, incomingProvenance, current);
				// also test aliases so a known alias maps correctly even if model_id differs
				if (status === 'NEW' && Array.isArray(item.aliases)) {
					for (const a of item.aliases) {
						const s = classifyUpgrade(item.provider, a, item.prices, incomingProvenance, current);
						if (s !== 'NEW') { status = s; break; }
					}
				}
			} catch (e) {
				report.errors.push({ stage: 'classify', provider: item.provider, model: item.model_id, error: e.message });
				continue;
			}

			if (status === 'NEW') {
				// Thread the tripwire's discovery date (if any) into the drafting path for effective_from.
				const createdDate = tripwireCreatedDate(item, tripwireDates);
				const drafted = { ...item, createdDate };

				// Cross-check gate: a suspicious NEW model is drafted as `inferred` + needs_review so a
				// human only reviews the genuinely-uncertain ones. A clean, corroborated one stays as the
				// collector set it (typically verified).
				const gate = runGate({
					provider: item.provider,
					model_id: item.model_id,
					prices: item.prices,
					aliases: item.aliases,
					isNew: true,
					prior: null,
				});
				const downgrade = gate.verdict === 'needs_review';
				const reasonNote = downgrade
					? `[needs_review] cross-check flagged: ${gate.reasons.join('; ')}.`
					: undefined;

				report.new_models.push({
					provider: item.provider,
					model_id: item.model_id,
					display_name: item.display_name || null,
					prices: item.prices,
					confidence: downgrade ? 'inferred' : item.confidence,
					source_kind: item.source_kind,
					effective_from: effectiveFromFor(drafted),
					crosscheck: { verdict: gate.verdict, reasons: gate.reasons },
				});
				try {
					report.drafted_records.push(
						...draftRecordsFor(drafted, downgrade ? { confidenceOverride: 'inferred', notesPrefix: reasonNote } : undefined)
					);
				} catch (e) {
					// fail loud per-model: a bad draft is a bug, surface it but keep the run alive
					report.errors.push({ stage: 'draft', provider: item.provider, model: item.model_id, error: e.message });
				}
			} else if (status === 'CHANGED') {
				const canonical = current.resolve(item.provider, item.model_id) || item.model_id;
				const have = current.byProviderModel.get(`${item.provider}/${canonical}`) || {};
				const diffs = {};
				for (const [v, p] of Object.entries(item.prices)) {
					if (typeof p === 'number' && v in have && have[v] !== p) diffs[v] = { from: have[v], to: p };
				}

				// Cross-check gate on the CHANGED price: flags the parse-error / transposition / suspicious-
				// magnitude class (the DeepSeek-false-positive class). `prior` is the published price.
				const gate = runGate({
					provider: item.provider,
					model_id: canonical,
					prices: item.prices,
					aliases: item.aliases,
					isNew: false,
					prior: have,
				});

				report.price_changes.push({
					provider: item.provider,
					model_id: canonical,
					// CHANGED prices are SUGGESTED edits, never auto-written; mirror the verdict so the
					// report can group them. Downgrade the advisory confidence label on a flag.
					confidence: gate.verdict === 'needs_review' ? 'inferred' : item.confidence,
					source_kind: item.source_kind,
					changes: diffs,
					crosscheck: { verdict: gate.verdict, reasons: gate.reasons },
				});
			} else if (status === 'UPGRADE') {
				// Same price, but the collector now confirms a model we hold at WEAKER provenance
				// (inferred/estimated, or aggregator/changelog/manual). Draft the stronger verified record
				// to SUPERSEDE the weaker one. These are first-party verified, so they flow into --apply.
				const canonical = current.resolve(item.provider, item.model_id) || item.model_id;
				const fromProv = current.provenanceFor(item.provider, item.model_id) || {};
				// pick a representative current {confidence, source_kind} (the first weak variation, else any)
				const variations = Object.keys(fromProv);
				const weakVar =
					variations.find((v) => fromProv[v] && (fromProv[v].confidence !== 'verified' || fromProv[v].source_kind !== 'provider_live')) ||
					variations[0];
				const from = weakVar
					? { confidence: fromProv[weakVar].confidence, source_kind: fromProv[weakVar].source_kind }
					: { confidence: null, source_kind: null };
				const to = { confidence: item.confidence, source_kind: item.source_kind };

				// Cross-check the upgrade too (fail-safe): a verified first-party record should pass, but a
				// flagged one is drafted as `inferred` + needs_review like any other suspicious row.
				const createdDate = tripwireCreatedDate(item, tripwireDates);
				const drafted = { ...item, model_id: canonical, createdDate };
				const gate = runGate({
					provider: item.provider,
					model_id: canonical,
					prices: item.prices,
					aliases: item.aliases,
					isNew: false,
					prior: current.byProviderModel.get(`${item.provider}/${canonical}`) || null,
				});
				const downgrade = gate.verdict === 'needs_review';
				const upgradeNote =
					`[provenance upgrade] first-party collector confirmed the published price; supersedes the ` +
					`prior ${from.confidence}/${from.source_kind} record.`;
				const reasonNote = downgrade
					? `${upgradeNote} [needs_review] cross-check flagged: ${gate.reasons.join('; ')}.`
					: upgradeNote;

				report.upgrades.push({
					provider: item.provider,
					model_id: canonical,
					from,
					to: downgrade ? { confidence: 'inferred', source_kind: to.source_kind } : to,
					prices: item.prices,
					crosscheck: { verdict: gate.verdict, reasons: gate.reasons },
				});
				try {
					report.drafted_records.push(
						...draftRecordsFor(
							drafted,
							downgrade
								? { confidenceOverride: 'inferred', notesPrefix: reasonNote }
								: { notesPrefix: reasonNote }
						)
					);
				} catch (e) {
					report.errors.push({ stage: 'draft', provider: item.provider, model: canonical, error: e.message });
				}
			}
			// UNCHANGED: nothing to report
		}
	}

	// 3b. PENDING first-party surfacing (Part B). A tripwire-detected NEW model for a mainstream
	// provider that NO first-party collector surfaced this run is "announced but not yet on the
	// provider's own pricing page". We do NOT draft a price (an aggregator/reseller number would break
	// our first-party pledge) - we only LIST it for day-0 human awareness, with the reseller price
	// clearly labeled a HINT (never written to the dataset).
	//
	// "NEW FAMILY" filter: the tripwire surfaces ~150 NEW candidates, but almost all are long-tail noise
	// (open-weight size/quant SKUs and dated/variant snapshots of families we already track). We keep
	// ONLY a genuinely-new model FAMILY from a core lab that we do not track at all - the rare signal
	// worth a human's attention - and count the rest in report.pending_filtered_out for transparency.
	const trackedFamilyRoots = buildTrackedFamilyRoots(current);
	const pendingSeen = new Set(); // dedupe per provider+normalized id
	for (const c of report.tripwire_candidates) {
		if (!c || c.status !== 'NEW' || typeof c.provider !== 'string') continue;
		const ids = [c.bare_id, c.source_id].filter((x) => typeof x === 'string');
		// surfaced by a first-party collector this run? then it is already in new_models - skip.
		const surfaced = ids.some((id) => collectorSeenKeys.has(`${c.provider}/${normalizeModelKey(id)}`));
		if (surfaced) continue;
		const normKey = normalizeModelKey(c.bare_id || c.source_id || '');
		const dedupeKey = `${c.provider}/${normKey}`;
		if (!normKey || pendingSeen.has(dedupeKey)) continue;
		pendingSeen.add(dedupeKey);

		// Drop long-tail size/quant/variant/known-family SKUs; keep only genuinely-new families.
		const verdict = classifyPendingCandidate(
			{ provider: c.provider, modelId: c.bare_id || c.source_id },
			{ trackedFamilyRoots, current }
		);
		if (!verdict.keep) {
			report.pending_filtered_out++;
			continue;
		}

		// reseller hint (OpenRouter only); HuggingFace heads-ups carry no price.
		const inHint = typeof c.reseller_input_usd_per_mtok === 'number' ? c.reseller_input_usd_per_mtok : null;
		const outHint = typeof c.reseller_output_usd_per_mtok === 'number' ? c.reseller_output_usd_per_mtok : null;
		report.pending_first_party.push({
			provider: c.provider,
			model_id: c.bare_id || c.source_id,
			detected_date: c.created || null,
			source: c.source,
			openrouter_price_hint:
				inHint === null && outHint === null
					? null
					: { input: inHint, output: outHint, note: 'HINT ONLY - OpenRouter reseller price, NOT first-party, NOT written to the dataset.' },
		});
	}

	// 4. emit
	if (apply) {
		let written = [];
		if (report.drafted_records.length) {
			written = applyDraftedRecords(report.drafted_records);
		}
		const md = renderReportMd(report, written);
		const mdPath = join(REPO_ROOT, 'sentinel-report.md');
		writeFileSync(mdPath, md);

		// summary of what was written
		const addedTotal = written.reduce((n, w) => n + w.added, 0);
		console.error(
			`sentinel apply: ${report.new_models.length} new model(s) + ${report.upgrades.length} provenance upgrade(s) ` +
				`-> ${addedTotal} record(s) appended` +
				(written.length ? ` (${written.map((w) => `${w.file} +${w.added}`).join(', ')})` : ' (no JSON changes)') +
				`; ${report.price_changes.length} suggested CHANGED edit(s); ` +
				`${report.pending_first_party.length} detected awaiting first-party price ` +
				`(${report.pending_filtered_out} variant/open-weight SKUs filtered out); ` +
				`cross-check: ${report.crosscheck.auto_verified} auto-verified, ${report.crosscheck.needs_review} need review; ` +
				`${report.errors.length} error(s). Wrote sentinel-report.md.`
		);
		return;
	}

	if (jsonOnly) {
		console.log(JSON.stringify(report));
		return;
	}

	console.log(JSON.stringify(report, null, 2));
	// human summary footer
	console.error(
		`\nsentinel ${report.mode}: ${report.tripwire_candidates.length} tripwire candidate(s), ` +
			`${report.new_models.length} new model(s), ${report.price_changes.length} price change(s), ` +
			`${report.upgrades.length} provenance upgrade(s), ${report.pending_first_party.length} pending first-party ` +
			`(${report.pending_filtered_out} variant/open-weight SKUs filtered out), ` +
			`${report.drafted_records.length} drafted record(s), ` +
			`cross-check: ${report.crosscheck.auto_verified} auto-verified / ${report.crosscheck.needs_review} need review, ` +
			`${report.errors.length} error(s). No files written.`
	);
}

main().catch((e) => {
	console.error('sentinel run failed:', e.stack || e.message);
	process.exit(1);
});
