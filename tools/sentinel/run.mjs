#!/usr/bin/env node
// tools/sentinel/run.mjs  (MIT)
// Price-sentinel orchestrator. DEFAULT = dry-run: it writes NOTHING, it only reports.
//
//   node tools/sentinel/run.mjs            # dry-run report (default)
//   node tools/sentinel/run.mjs --dry-run  # explicit; identical to the default
//   node tools/sentinel/run.mjs --json     # report as compact JSON only
//
// It:
//   1. polls the keyless tripwires (OpenRouter + HuggingFace) for mainstream NEW/CHANGED candidates,
//   2. runs the first-party collectors via a small provider->collector registry
//      (Round 2 adds one line per new collector),
//   3. diffs each collected model against the published current prices (alias-aware), and
//   4. prints a report:
//        { generated_at, tripwire_candidates, new_models, price_changes, drafted_records, errors }
//      where drafted_records are FULL valid contribution-form records for NEW models (each built via
//      makeRecord, so an invalid one throws rather than being emitted). price_changes are LISTED only -
//      Round 1 never auto-writes bitemporal edits.
//
// Per-collector errors are caught into report.errors so one dead source does not kill the run.

import { today, loadCurrent, classify, makeRecord } from './lib.mjs';
import { findCandidates } from './tripwire.mjs';
import * as anthropic from './collectors/anthropic.mjs';
import * as llama from './collectors/llama.mjs';

// provider -> collector. Round 2: add openai/google/etc here, one line each.
const COLLECTORS = [
	{ provider: 'anthropic', collect: anthropic.collect },
	{ provider: 'meta-llama', collect: llama.collect },
];

// Which extracted variations become contribution records (in this order).
const RECORD_VARIATIONS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

function effectiveFromFor(item) {
	// We do not invent a precise launch date for a model we just discovered. Use today as a safe,
	// non-future effective_from for a freshly-observed live price; a human/Round-2 backfill can
	// correct it with a dated snapshot id + announcement date. Never emit a future date.
	return today();
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

async function main() {
	const args = process.argv.slice(2);
	const jsonOnly = args.includes('--json');
	// dry-run is the default and the only supported mode in Round 1; the flag is accepted for clarity.
	const dryRun = !args.includes('--write');
	if (!dryRun) {
		console.error('run.mjs: --write is not implemented in Round 1 (the orchestrator owns writes). Refusing.');
		process.exit(2);
	}

	const current = loadCurrent();
	const report = {
		generated_at: today(),
		mode: 'dry-run',
		tripwire_candidates: [],
		new_models: [],
		price_changes: [],
		drafted_records: [],
		errors: [],
	};

	// 1. tripwire (advisory)
	try {
		const { candidates, errors } = await findCandidates({ current });
		report.tripwire_candidates = candidates;
		for (const e of errors) report.errors.push({ stage: 'tripwire', source: e.source, error: e.error });
	} catch (e) {
		report.errors.push({ stage: 'tripwire', error: e.message });
	}

	// 2 + 3. collectors + diff
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
				report.new_models.push({
					provider: item.provider,
					model_id: item.model_id,
					display_name: item.display_name || null,
					prices: item.prices,
					confidence: item.confidence,
					source_kind: item.source_kind,
				});
				try {
					report.drafted_records.push(...draftRecordsFor(item));
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
