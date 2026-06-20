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
import { today, loadCurrent, classify, makeRecord, effectiveFromForNew, REPO_ROOT } from './lib.mjs';
import { findCandidates } from './tripwire.mjs';
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

/** Turn one collected model into 1..N contribution-form records (NEW models only). */
function draftRecordsFor(item) {
	const recs = [];
	const effective_from = effectiveFromFor(item);
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
				confidence: item.confidence,
				aliases: item.aliases,
				notes: item.notes,
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
			`${report.tripwire_candidates.length} tripwire candidate(s), ${report.errors.length} error(s).`
	);
	L.push('');

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
		drafted_records: [],
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
			let status;
			try {
				status = classify(item.provider, item.model_id, item.prices, current);
				// also test aliases so a known alias maps correctly even if model_id differs
				if (status === 'NEW' && Array.isArray(item.aliases)) {
					for (const a of item.aliases) {
						const s = classify(item.provider, a, item.prices, current);
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
				report.new_models.push({
					provider: item.provider,
					model_id: item.model_id,
					display_name: item.display_name || null,
					prices: item.prices,
					confidence: item.confidence,
					source_kind: item.source_kind,
					effective_from: effectiveFromFor(drafted),
				});
				try {
					report.drafted_records.push(...draftRecordsFor(drafted));
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
				report.price_changes.push({
					provider: item.provider,
					model_id: canonical,
					confidence: item.confidence,
					source_kind: item.source_kind,
					changes: diffs,
				});
			}
			// UNCHANGED: nothing to report
		}
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
			`sentinel apply: ${report.new_models.length} new model(s) -> ${addedTotal} record(s) appended` +
				(written.length ? ` (${written.map((w) => `${w.file} +${w.added}`).join(', ')})` : ' (no JSON changes)') +
				`; ${report.price_changes.length} suggested CHANGED edit(s); ${report.errors.length} error(s). ` +
				`Wrote sentinel-report.md.`
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
			`${report.drafted_records.length} drafted record(s), ${report.errors.length} error(s). ` +
			'No files written.'
	);
}

main().catch((e) => {
	console.error('sentinel run failed:', e.stack || e.message);
	process.exit(1);
});
