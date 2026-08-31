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
	missingVariations,
	makeRecord,
	effectiveFromForNew,
	REPO_ROOT,
	buildTrackedFamilyRoots,
	classifyPendingCandidate,
	isStrongerProvenance,
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
	{ provider: 'alibaba', collect: alibaba.collect, getNotices: alibaba.getNotices },
	{ provider: 'xai', collect: xai.collect },
	{ provider: 'openai', collect: openai.collect, getNotices: openai.getNotices },
	{ provider: 'cohere', collect: cohere.collect },
];

// Which extracted variations become contribution records (in this order).
// tier2_* (long-context tiers, e.g. Gemini >200K or Grok >128K) were missing from this list until
// 2026-07-31, so collectors extracted them and drafting silently dropped them on the floor - the same
// discard-what-we-read bug as the missing-variation gap below, one layer further down.
//
// `cache_write` is the UNTIMED cache-write rate (OpenAI publishes one "Cache writes" column with no
// TTL dimension). It is deliberately NOT folded into cache_write_5m/cache_write_1h, which are
// Anthropic's two TTL-specific rates: collapsing them would assert a TTL the vendor never stated.
// tier2_cache_read / tier2_cache_write are the same rates under a long-context tier.
const RECORD_VARIATIONS = [
	'input',
	'output',
	'cache_read',
	'cache_write',
	'cache_write_5m',
	'cache_write_1h',
	'tier2_input',
	'tier2_output',
	'tier2_cache_read',
	'tier2_cache_write',
];

/**
 * Resolve a non-future effective_from for a NEW model. Delegates the date policy to lib's
 * effectiveFromForNew: a threaded tripwire discovery date (item.createdDate) when present + valid +
 * not-future, else today(). Kept as a thin wrapper so the threading site reads cleanly.
 */
function effectiveFromFor(item) {
	return effectiveFromForNew(item.createdDate, today());
}

/**
 * Turn one collected model into 1..N contribution-form records.
 * `confidenceOverride` (optional) replaces item.confidence when the cross-check gate downgraded the
 * model to needs_review (e.g. 'inferred'); `notesPrefix` (optional) is prepended to notes so the
 * reasons travel with the drafted record into the PR.
 *
 * `onlyVariations` + `effectiveFromOverride` serve the missing-variation path, which adds rows to a
 * model we ALREADY track. There the model's own launch date is not evidence for when an unrecorded
 * cache or long-context rate began, so that caller pins effective_from to the observation date and
 * says so in the note, rather than back-dating an assertion nobody verified.
 */
function draftRecordsFor(item, { confidenceOverride, notesPrefix, onlyVariations, effectiveFromOverride } = {}) {
	const recs = [];
	const effective_from = effectiveFromOverride || effectiveFromFor(item);
	const confidence = confidenceOverride || item.confidence;
	let notes = item.notes;
	if (notesPrefix) notes = notes ? `${notesPrefix} ${notes}` : notesPrefix;
	const wanted = onlyVariations ? new Set(onlyVariations) : null;
	for (const variation of RECORD_VARIATIONS) {
		if (wanted && !wanted.has(variation)) continue;
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
 * JSON array if it does not exist. Preserves 2-space indentation + a single trailing newline
 * (JSON.stringify(records, null, 2) + "\n").
 * Returns [{ provider, file, added }].
 */
function applyDraftedRecords(drafted) {
	const byProvider = new Map();
	for (const rec of drafted) {
		if (!byProvider.has(rec.provider)) byProvider.set(rec.provider, []);
		byProvider.get(rec.provider).push(rec);
	}
	const written = [];
	const conflicts = [];
	for (const [provider, recs] of byProvider) {
		const path = recordsPathFor(provider);
		let existing = [];
		if (existsSync(path)) {
			const parsed = JSON.parse(readFileSync(path, 'utf8'));
			if (!Array.isArray(parsed)) throw new Error(`${path} is not a JSON array; refusing to append.`);
			existing = parsed;
		}

		// Skip a record that is already byte-for-byte the same assertion. The sentinel reads what we
		// PUBLISH (current.json) but writes what we RECORD (data/records), and the two only reconverge
		// when publish-on-merge re-exports on the VPS. In the window between a merge and that export, a
		// scheduled run re-derives the same finding and would append it a second time. An exact match on
		// model + variation + effective_from + price is never a legitimate bitemporal edit (a correction
		// moves the price or the date), so dropping it is safe and keeps the records file idempotent.
		const seen = new Set(existing.map((r) => `${r.model_id}|${r.variation}|${r.effective_from}|${r.price_usd}`));
		const fresh = recs.filter((r) => !seen.has(`${r.model_id}|${r.variation}|${r.effective_from}|${r.price_usd}`));
		if (!fresh.length) continue;

		// A drafted record SUPERSEDES whatever is still open for the same model+variation - a provenance
		// upgrade re-states today's price at a higher confidence. Appending without closing the old row
		// leaves two rows open, and since consumers read the current price as "the row where
		// effective_to is empty", that makes the current price ambiguous. Close it at the new record's
		// effective_from, the half-open [from, to) convention the rest of the dataset already uses.
		for (const rec of fresh) {
			for (const prior of existing) {
				if (prior.model_id !== rec.model_id || prior.variation !== rec.variation) continue;
				if ((prior.effective_to ?? null) !== null) continue;
				if (prior.effective_from < rec.effective_from) {
					prior.effective_to = rec.effective_from;
				} else {
					// Same-day or backwards: no reading of this is obviously right, so leave both rows
					// alone and surface it rather than invent an interval.
					conflicts.push({
						provider,
						model_id: rec.model_id,
						variation: rec.variation,
						error:
							`drafted record effective_from ${rec.effective_from} does not follow the open ` +
							`record's ${prior.effective_from}; left both open for a human to resolve.`,
					});
				}
			}
		}

		existing.push(...fresh);
		writeFileSync(path, JSON.stringify(existing, null, 2) + '\n');
		written.push({ provider, file: join('data', 'records', `${provider}.json`), added: fresh.length });
	}
	return { written, conflicts };
}

/** Render the human-readable sentinel-report.md used as the PR body. */
function renderReportMd(report, written) {
	const L = [];
	// Cross-check gate: the correctness differentiator. Auto-verified items are safe to merge with a
	// glance; needs-review items are downgraded to `inferred` and listed with the reasons a human
	// should resolve before flipping them back to verified.
	const cc = report.crosscheck || { auto_verified: 0, needs_review: 0, items: [] };
	// A collector whose source changed shape stops monitoring that provider silently. Counted
	// separately from `errors` because an unreachable source is transient and must not raise a PR.
	const broken = report.broken_collectors || [];
	L.push('# Price Sentinel report');
	L.push('');
	L.push(`Generated ${report.generated_at} by \`.github/workflows/price-sentinel.yml\` (\`node tools/sentinel/run.mjs --apply\`).`);
	L.push('');
	// The workflow's has_findings gate parses this line, so every term that can require a human
	// decision must appear here - `needs review` included.
	L.push(
		`Summary: ${report.new_models.length} new model(s), ${report.price_changes.length} price change(s), ` +
			`${report.missing_variations.length} model(s) with missing variation(s), ` +
			`${report.untracked_models.length} untracked model(s) on a provider page, ` +
			`${report.upgrades.length} provenance upgrade(s), ${cc.needs_review} cross-check item(s) needing review, ` +
			`${broken.length} broken collector(s), ` +
			`${report.pending_first_party.length} detected awaiting ` +
			`first-party price (${report.pending_filtered_out} variant/open-weight SKUs filtered out), ` +
			`${report.skipped_archived.length} archived model(s) skipped, ` +
			`${report.tripwire_candidates.length} tripwire candidate(s), ${report.errors.length} error(s).`
	);
	L.push('');

	L.push('## Cross-check gate');
	L.push('');
	L.push(
		`The correctness gate ran on every NEW model, CHANGED price and provenance UPGRADE: ` +
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
		L.push('| Provider | Model | From | To | Cross-check | Drafted |');
		L.push('|---|---|---|---|---|---|');
		for (const u of report.upgrades) {
			const from = `${u.from.confidence || '-'} / ${u.from.source_kind || '-'}`;
			const to = `${u.to.confidence || '-'} / ${u.to.source_kind || '-'}`;
			const cc = u.crosscheck && u.crosscheck.verdict === 'needs_review' ? 'needs review' : 'verified';
			const n = u.drafted_variations;
			const drafted = n === 0 ? 'no row (already at this provenance)' : `${n} row(s)`;
			L.push(`| \`${u.provider}\` | \`${u.model_id}\` | ${from} | ${to} | ${cc} | ${drafted} |`);
		}
		L.push('');
	} else {
		L.push('None.');
		L.push('');
	}

	// Missing variations: rates the provider publishes for a model we already track, that we carried no
	// row for. Purely ADDITIVE - no interval to close, nothing superseded - so unlike a CHANGED price
	// these are drafted straight into --apply.
	L.push('## Missing variations (rates we track the model but not the row)');
	L.push('');
	if (report.missing_variations.length) {
		L.push(
			'The collector read these rates off the provider\'s own page for a model we ALREADY track, but ' +
				'we published no row for them. They are ADDITIVE: no existing interval is closed and nothing ' +
				'is superseded, so they are drafted into `data/records` like a new model rather than listed as ' +
				'a suggested edit.'
		);
		L.push('');
		L.push(
			'**Check `effective_from` when reviewing.** It is the OBSERVATION date, not a known change ' +
				'date. The rate is very likely older than the record claims, but no dated first-party evidence ' +
				'exists for an earlier start, so back-dating it to the model\'s launch would assert something ' +
				'nobody verified.'
		);
		L.push('');
		L.push('| Provider | Model | Added | effective_from | Cross-check |');
		L.push('|---|---|---|---|---|');
		for (const mv of report.missing_variations) {
			const added = Object.entries(mv.added)
				.map(([v, p]) => `${v} $${p}`)
				.join(', ');
			const cc = mv.crosscheck && mv.crosscheck.verdict === 'needs_review' ? 'needs review' : 'verified';
			L.push(`| \`${mv.provider}\` | \`${mv.model_id}\` | ${added} | ${mv.effective_from} | ${cc} |`);
		}
		L.push('');
	} else {
		L.push('None.');
		L.push('');
	}

	// Untracked models: a model priced on the provider's OWN page that our collector's tracked set does
	// not name. This is the discovery path for collectors that gate emission on an allow-list; without
	// it a new model is not "NEW", it is invisible. Nothing is drafted - naming a model is a human call.
	L.push('## Untracked models on a provider page');
	L.push('');
	if (report.untracked_models.length) {
		L.push(
			'These are priced on the provider\'s own pricing page but are not in the collector\'s tracked ' +
				'set, so no record was drafted for them. This is a DECISION, not a diff: add each to the ' +
				'collector\'s TRACKED set to start recording it, or to its known-untracked list with a reason ' +
				'to keep ignoring it. Leaving it here means the model stays unpriced in the index.'
		);
		L.push('');
		L.push('| Provider | Model | Seen as | Source |');
		L.push('|---|---|---|---|');
		for (const um of report.untracked_models) {
			L.push(`| \`${um.provider}\` | \`${um.model_id}\` | ${um.display_name} | ${um.source_url} |`);
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

	// Skipped (archived) - a tripwire/collector candidate that maps to a model we DELIBERATELY archived
	// in data/records (retired/EOL). EOL models linger on provider pricing pages for weeks; we never
	// re-draft them. Keyed off our RECORDS' archived state, not current.json.
	L.push('## Skipped (archived in our records)');
	L.push('');
	if (report.skipped_archived.length) {
		L.push(
			'These candidates map to a model we have DELIBERATELY archived (retired/EOL) in ' +
				'`data/records`. The provider may still list them, but we do NOT resurrect an archived model. ' +
				'No record was drafted.'
		);
		L.push('');
		L.push('| Provider | Model |');
		L.push('|---|---|');
		for (const s of report.skipped_archived) L.push(`| \`${s.provider}\` | \`${s.model_id}\` |`);
		L.push('');
	} else {
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

	L.push('## Broken collectors');
	L.push('');
	if (broken.length) {
		L.push(
			`${broken.map((p) => `\`${p}\``).join(', ')} reached the source but could not read it. ` +
				'Those providers are NOT being price-checked until the collector is repointed.'
		);
		L.push('');
	} else {
		L.push('None. Every collector read its source.');
		L.push('');
	}

	// Errors + BLOCKED providers
	L.push('## Errors and BLOCKED providers');
	L.push('');
	if (report.errors.length) {
		L.push('One dead source never kills the run; these are surfaced for visibility (e.g. xAI is BLOCKED without a key).');
		L.push('');
		L.push('| Stage | Provider/Source | Kind | Error |');
		L.push('|---|---|---|---|');
		for (const e of report.errors) {
			const who = e.provider || e.source || '-';
			const msg = String(e.error || '').replace(/\|/g, '\\|');
			L.push(`| ${e.stage} | \`${who}\` | ${e.kind || '-'} | ${msg} |`);
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
		missing_variations: [],
		untracked_models: [],
		upgrades: [],
		pending_first_party: [],
		pending_filtered_out: 0,
		skipped_archived: [],
		drafted_records: [],
		crosscheck: { auto_verified: 0, needs_review: 0, items: [] },
		broken_collectors: [],
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
			// `unavailable` = we never got the bytes (DNS, timeout, non-2xx). Transient, and a source
			// that is merely down must not raise a PR every run. Anything else means we DID receive the
			// page and could not understand it, so that provider is now unmonitored: a finding.
			const kind = e && e.code === 'SOURCE_UNAVAILABLE' ? 'unavailable' : 'parse';
			report.errors.push({ stage: 'collector', provider: c.provider, kind, error: e.message });
			continue;
		}

		// A collector that succeeds but returns nothing is broken in the same way, just quietly:
		// no throw, no models, no monitoring. Every provider we track sells at least one model.
		if (!Array.isArray(items) || items.length === 0) {
			report.errors.push({
				stage: 'collector',
				provider: c.provider,
				kind: 'parse',
				error: 'collector returned 0 models - the source parsed but yielded nothing.',
			});
			continue;
		}

		// Optional out-of-band channel: a collector that gates emission on an allow-list reports the
		// models it SAW but does not track. Without this a new model from such a provider is not
		// detected-and-skipped, it is invisible - which is how OpenAI's whole gpt-5.6 family shipped
		// without the index noticing. Read only on success; a throwing collector has nothing to say.
		if (typeof c.getNotices === 'function') {
			for (const n of c.getNotices()) {
				if (n && n.kind === 'untracked_model') report.untracked_models.push(n);
			}
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
				// Never RESURRECT a model we have deliberately archived in data/records, even if the
				// provider's page still lists it (EOL models linger on pricing pages for weeks). classify()
				// reads NEW from current.json, which omits archived models - this archived-in-records check
				// is the durable guard that keeps the sentinel from re-drafting a retired model.
				const archivedId = [item.model_id, ...(Array.isArray(item.aliases) ? item.aliases : [])].find((id) =>
					current.isArchived(item.provider, id)
				);
				if (archivedId) {
					report.skipped_archived.push({ provider: item.provider, model_id: item.model_id });
					continue;
				}

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
				// NOT tripwireCreatedDate: that is when the MODEL appeared, which is the right
				// effective_from for a NEW model and the wrong one here. An upgrade dates from when WE
				// confirmed the price first-party, i.e. today. Using the model's creation date made the
				// drafted row an exact match for the row it was meant to supersede, so the append-time
				// dedup dropped it and the upgrade silently became a no-op.
				const drafted = { ...item, model_id: canonical };
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

				// Restrict the upgrade to the variations we ALREADY publish. An upgrade supersedes an
				// existing row; a variation we carry no row for is not an upgrade, it is a missing
				// variation, and the pass below owns it. Drafting both produced two open records for the
				// same variation in one run (caught by validate as an ambiguous current price).
				// Then drop any variation the draft would not strictly improve: a cross-check downgrade can
				// land on the provenance we already hold (a no-op supersede that re-drafts every run), or
				// BELOW it, which would demote a row another pass had already verified.
				const draftedProv = {
					confidence: downgrade ? 'inferred' : item.confidence,
					source_kind: item.source_kind,
				};
				const publishedVariations = Object.keys(
					current.byProviderModel.get(`${item.provider}/${canonical}`) || {}
				).filter((v) => isStrongerProvenance(fromProv[v], draftedProv));

				report.upgrades.push({
					provider: item.provider,
					model_id: canonical,
					from,
					to: downgrade ? { confidence: 'inferred', source_kind: to.source_kind } : to,
					prices: item.prices,
					drafted_variations: publishedVariations.length,
					crosscheck: { verdict: gate.verdict, reasons: gate.reasons },
				});

				if (publishedVariations.length) {
					try {
						report.drafted_records.push(
							...draftRecordsFor(drafted, {
								onlyVariations: publishedVariations,
								effectiveFromOverride: today(),
								...(downgrade
									? { confidenceOverride: 'inferred', notesPrefix: reasonNote }
									: { notesPrefix: reasonNote }),
							})
						);
					} catch (e) {
						report.errors.push({ stage: 'draft', provider: item.provider, model: canonical, error: e.message });
					}
				}
			}
			// UNCHANGED: no price moved, but see the missing-variation pass below.

			// Prices the collector read off the provider's page for a model we ALREADY track but carry
			// no row for. Deliberately OUTSIDE the status branches: status answers "did a recorded price
			// move", and a model can have a CHANGED input rate and an unrecorded cache rate in the same
			// run, so both must be reportable together. NEW is excluded because its own path already
			// drafts every variation.
			if (status !== 'NEW') {
				let gap = null;
				try {
					gap = missingVariations(item.provider, item.model_id, item.prices, current);
					if (!gap && Array.isArray(item.aliases)) {
						for (const a of item.aliases) {
							gap = missingVariations(item.provider, a, item.prices, current);
							if (gap) break;
						}
					}
				} catch (e) {
					report.errors.push({
						stage: 'missing-variations',
						provider: item.provider,
						model: item.model_id,
						error: e.message,
					});
					gap = null;
				}

				// Never grow an archived model: same guard the NEW path uses. A retired model lingers on
				// pricing pages for weeks and we do not resurrect it, in whole or by the variation.
				const archived = [item.model_id, ...(Array.isArray(item.aliases) ? item.aliases : [])].some((id) =>
					current.isArchived(item.provider, id)
				);

				if (gap && !archived) {
					const prior = current.byProviderModel.get(`${item.provider}/${gap.canonical}`) || null;
					const gate = runGate({
						provider: item.provider,
						model_id: gap.canonical,
						prices: gap.missing,
						aliases: item.aliases,
						isNew: false,
						prior,
					});
					const downgrade = gate.verdict === 'needs_review';

					// effective_from is the OBSERVATION date, never the model's launch date. We are adding a
					// rate we have never recorded; the fact that the model shipped in March is not evidence
					// that this cache rate applied in March. Stale-but-labelled is acceptable here,
					// silently-backdated is not (METHODOLOGY: label uncertainty honestly).
					const observed = today();
					const note =
						`[missing variation] Added by the sentinel's missing-variation pass: the provider ` +
						`publishes this rate alongside the input/output prices we already track, but we carried ` +
						`no row for it. effective_from is the OBSERVATION date, NOT a known change date - the ` +
						`rate is very likely older, and no dated first-party evidence exists for an earlier start.` +
						(downgrade ? ` [needs_review] cross-check flagged: ${gate.reasons.join('; ')}.` : '');

					report.missing_variations.push({
						provider: item.provider,
						model_id: gap.canonical,
						added: gap.missing,
						confidence: downgrade ? 'inferred' : item.confidence,
						source_kind: item.source_kind,
						effective_from: observed,
						crosscheck: { verdict: gate.verdict, reasons: gate.reasons },
					});
					try {
						report.drafted_records.push(
							...draftRecordsFor(
								{ ...item, model_id: gap.canonical },
								{
									onlyVariations: Object.keys(gap.missing),
									effectiveFromOverride: observed,
									confidenceOverride: downgrade ? 'inferred' : undefined,
									notesPrefix: note,
								}
							)
						);
					} catch (e) {
						report.errors.push({
							stage: 'draft',
							provider: item.provider,
							model: gap.canonical,
							error: e.message,
						});
					}
				}
			}
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

		// Never surface (or later resurrect) a model we have deliberately archived in data/records, even
		// when the tripwire still detects it as NEW. Keyed off our RECORDS' archived state, not current.json.
		const archivedPendingId = ids.find((id) => current.isArchived(c.provider, id));
		if (archivedPendingId) {
			report.skipped_archived.push({ provider: c.provider, model_id: c.bare_id || c.source_id });
			continue;
		}

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
	report.broken_collectors = [
		...new Set(report.errors.filter((e) => e.stage === 'collector' && e.kind === 'parse').map((e) => e.provider)),
	].sort();

	if (apply) {
		let written = [];
		if (report.drafted_records.length) {
			const applied = applyDraftedRecords(report.drafted_records);
			written = applied.written;
			for (const c of applied.conflicts) {
				report.errors.push({
					stage: 'apply',
					provider: `${c.provider}/${c.model_id} ${c.variation}`,
					kind: 'conflict',
					error: c.error,
				});
			}
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
				`${report.skipped_archived.length} archived model(s) skipped; ` +
				`cross-check: ${report.crosscheck.auto_verified} auto-verified, ${report.crosscheck.needs_review} need review; ` +
				`${report.broken_collectors.length} broken collector(s)` +
				(report.broken_collectors.length ? ` (${report.broken_collectors.join(', ')})` : '') +
				`; ${report.errors.length} error(s). Wrote sentinel-report.md.`
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
			`${report.skipped_archived.length} archived skipped, ` +
			`${report.drafted_records.length} drafted record(s), ` +
			`cross-check: ${report.crosscheck.auto_verified} auto-verified / ${report.crosscheck.needs_review} need review, ` +
			`${report.errors.length} error(s). No files written.`
	);
}

main().catch((e) => {
	console.error('sentinel run failed:', e.stack || e.message);
	process.exit(1);
});
