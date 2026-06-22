#!/usr/bin/env python3
# tools/audit/litellm-ledger.py
#
# The aggregator-accuracy ledger. RECORDS, for the historical record, where BerriAI/litellm's
# pricing data disagrees with OUR high-confidence (first-party-validated) data - i.e. where we
# are confident LiteLLM is the wrong party - and how long each disagreement stands before LiteLLM
# comes to match us. It is a strategic data asset, NOT an input to any correction flow: it opens
# no PRs anywhere, and it never proposes changes to LiteLLM.
#
# It reuses the daily pricing-audit's model-id matching + IGNORE_RATE_DIFFS set + float tolerance,
# so the ledger carries the same signal the audit already trusts. It records only the
# (model, variation) pairs whose OUR value is high-confidence: confidence in {verified, archived}.
# Inferred/estimated pairs are skipped - if our own number is not first-party-validated, a LiteLLM
# disagreement is not evidence LiteLLM is wrong, so it does not belong in an "accuracy" ledger.
#
# A note on IGNORE_RATE_DIFFS. In pricing-audit.yml that set suppresses pairs where "WE are
# verified-correct and LiteLLM is wrong" so the audit does not reopen a noise PR proposing we change
# OUR value to match LiteLLM's wrong one. For THIS ledger the semantics flip: a confirmed-
# LiteLLM-wrong pair is the highest-value record, not noise - it is exactly the "LiteLLM is wrong"
# event we want to time. So the ledger does NOT drop IGNORE_RATE_DIFFS pairs; it records them and
# flags them confirmed_litellm_wrong=true (a human has already verified LiteLLM is the wrong party).
# The two files keep ONE shared IGNORE_RATE_DIFFS list, used for opposite-but-consistent ends.
#
# Output: data/aggregator-accuracy/litellm.json - a deterministic, sorted JSON document. Pass
# today's date in (AIPI_TODAY or argv[1]); the compare logic never reads the wall clock, so a run
# where nothing changed reproduces a byte-identical file (no daily churn commit).
#
# Usage:
#   AIPI_TODAY=2026-06-22 python3 tools/audit/litellm-ledger.py
#   python3 tools/audit/litellm-ledger.py 2026-06-22 [path/to/litellm.json] [path/to/current.json] [path/to/ledger.json]
#
# Exit 0 always (it is a recorder, not a gate). Prints whether the ledger changed.

import json
import os
import sys
from datetime import datetime, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

LEDGER_PATH = os.path.join(REPO_ROOT, "data", "aggregator-accuracy", "litellm.json")
CURRENT_PATH = os.path.join(REPO_ROOT, "data", "ai-price-index", "current.json")

# Same tolerance as pricing-audit.yml: whole-dollar Claude pricing means a real change is >= $0.50,
# so $0.01/MTok safely separates "matches" from "disagrees" without float-noise false positives.
TOLERANCE = 0.01

# High-confidence == first-party-validated, so we are confident LiteLLM (not us) is wrong.
HIGH_CONFIDENCE = {"verified", "archived"}

# Kept identical to IGNORE_RATE_DIFFS in .github/workflows/pricing-audit.yml (keep the two in sync).
# In the audit it suppresses a noise PR; in this ledger it MARKS the pair confirmed_litellm_wrong
# (a human has already verified LiteLLM, not us, is wrong) - so the ledger records it rather than
# dropping it. A pair NOT in this set but still disagreeing against our high-confidence value is
# recorded too, just without the human-confirmed flag.
IGNORE_RATE_DIFFS = {
    ("xai", "grok-4.20-0309-reasoning"),  # LiteLLM $2/$6; x.ai pricing page is $1.25/$2.50 (verified 2026-06-17)
}


def today_utc():
    t = os.environ.get("AIPI_TODAY")
    if len(sys.argv) > 1 and sys.argv[1]:
        t = sys.argv[1]
    if t:
        return t
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def litellm_rate_p(litellm, provider, model):
    # Provider-aware lookup, identical to pricing-audit.yml's litellm_rate_p: LiteLLM keys some
    # models bare and some provider-prefixed. Try a few forms; None (no match) means "not
    # auto-watched" and is skipped rather than flagged, so unmatched models never false-positive.
    for key in (model, f"{provider}/{model}", f"{model}-latest"):
        entry = litellm.get(key)
        if entry is not None:
            return (
                entry.get("input_cost_per_token", 0) * 1_000_000,
                entry.get("output_cost_per_token", 0) * 1_000_000,
            )
    return None


def build_observed(current, litellm):
    """Today's observed high-confidence disagreements, keyed by (provider, model, variation).

    Value carries everything the ledger entry needs that is fresh-from-this-run. first_detected
    is assigned by the upsert, not here.
    """
    # Per-(provider, model) our rates + the per-variation provenance (confidence / src /
    # last_validated) so the ledger can record WHY we trust our number over LiteLLM's.
    per_model = {}
    for p in current.get("prices", []):
        if p.get("variation") not in ("input", "output"):
            continue
        key = (p.get("provider"), p.get("model"))
        e = per_model.setdefault(key, {})
        e[p["variation"]] = {
            "price_usd": p.get("price_usd"),
            "confidence": p.get("confidence"),
            "src": p.get("src"),
            "last_validated": p.get("last_validated"),
        }

    observed = {}
    for (provider, model), variations in per_model.items():
        ll = litellm_rate_p(litellm, provider, model)
        if ll is None:
            continue  # LiteLLM does not carry this model in a form we match: not auto-watched.
        confirmed = (provider, model) in IGNORE_RATE_DIFFS
        ll_by_var = {"input": ll[0], "output": ll[1]}
        for variation in ("input", "output"):
            ours = variations.get(variation)
            if ours is None or ours.get("price_usd") is None:
                continue
            if ours.get("confidence") not in HIGH_CONFIDENCE:
                continue  # only first-party-validated pairs belong in an accuracy ledger.
            ll_val = ll_by_var[variation]
            our_val = ours["price_usd"]
            if abs(ll_val - our_val) <= TOLERANCE:
                continue  # LiteLLM matches us within tolerance: not a disagreement.
            observed[(provider, model, variation)] = {
                "provider": provider,
                "model": model,
                "variation": variation,
                "litellm_usd_per_mtok": round(ll_val, 4),
                "our_usd_per_mtok": our_val,
                "our_source_url": ours.get("src"),
                "our_confidence": ours.get("confidence"),
                "our_last_validated": ours.get("last_validated"),
                # True when a human has already verified LiteLLM (not us) is the wrong party
                # (the pair is in the shared IGNORE_RATE_DIFFS set). The strongest record class.
                "confirmed_litellm_wrong": confirmed,
            }
    return observed


def load_ledger(path):
    if not os.path.exists(path):
        return {"entries": []}
    with open(path) as f:
        return json.load(f)


def entry_key(e):
    return (e["provider"], e["model"], e["variation"])


def days_between(start, end):
    a = datetime.strptime(start, "%Y-%m-%d").date()
    b = datetime.strptime(end, "%Y-%m-%d").date()
    return (b - a).days


def upsert(ledger, observed, today):
    """Merge today's observations into the persisted ledger entries.

    - new disagreement      -> first_detected = today, resolved = null
    - still-present          -> refresh last_seen + current litellm/our values + provenance; keep first_detected
    - previously-open, now matching (or no longer covered) -> set resolved = today; keep the entry
    - already-resolved that re-appears -> treat as a fresh disagreement (new first_detected)
    """
    prev = {}
    for e in ledger.get("entries", []):
        prev[entry_key(e)] = e

    merged = {}

    # 1. Walk observed: open or re-open every current disagreement.
    for k, obs in observed.items():
        existing = prev.get(k)
        if existing is not None and existing.get("resolved") is None:
            # still-present open disagreement: refresh current values + last_seen, keep first_detected.
            e = dict(existing)
            e.update(obs)
            e["last_seen"] = today
            # resolved stays None
            merged[k] = e
        else:
            # brand-new, or a re-opened previously-resolved pair: start a fresh open record.
            e = dict(obs)
            e["first_detected"] = today
            e["last_seen"] = today
            e["resolved"] = None
            merged[k] = e

    # 2. Walk persisted entries not observed today.
    for k, e in prev.items():
        if k in merged:
            continue  # already handled above (it was observed today).
        e = dict(e)
        if e.get("resolved") is None:
            # was open, now absent (LiteLLM matches us, or we no longer cover it): resolve it.
            e["resolved"] = today
        # already-resolved entries are kept verbatim for the historical record.
        merged[k] = e

    return list(merged.values())


def sort_entries(entries):
    # Deterministic ordering: open entries first (oldest first_detected first), then resolved
    # (most-recently-resolved first), tie-broken by the natural key. Ordering does not affect
    # byte-identity on a no-change run as long as it is a pure function of the data.
    def key(e):
        is_resolved = e.get("resolved") is not None
        return (
            1 if is_resolved else 0,
            e.get("resolved") or "",
            e.get("first_detected") or "",
            e["provider"],
            e["model"],
            e["variation"],
        )

    return sorted(entries, key=key)


def summarize(entries, today):
    open_entries = [e for e in entries if e.get("resolved") is None]
    resolved_entries = [e for e in entries if e.get("resolved") is not None]
    oldest_open_days = 0
    oldest_open = None
    for e in open_entries:
        d = days_between(e["first_detected"], today)
        if d > oldest_open_days or oldest_open is None:
            oldest_open_days = d
            oldest_open = {
                "provider": e["provider"],
                "model": e["model"],
                "variation": e["variation"],
                "first_detected": e["first_detected"],
            }
    confirmed_open = sum(1 for e in open_entries if e.get("confirmed_litellm_wrong"))
    return {
        "generated": today,
        "open_count": len(open_entries),
        "confirmed_open_count": confirmed_open,
        "resolved_count": len(resolved_entries),
        "oldest_open_days": oldest_open_days,
        "oldest_open": oldest_open,
    }


def build_document(entries, today):
    sorted_entries = sort_entries(entries)
    return {
        "_comment": (
            "Aggregator-accuracy ledger: where BerriAI/litellm disagrees with our high-confidence "
            "(first-party-validated) prices, and how long each disagreement stands. Recorder only - "
            "opens no PRs and proposes no changes upstream. Maintained by tools/audit/litellm-ledger.py."
        ),
        "aggregator": "litellm",
        "summary": summarize(sorted_entries, today),
        "entries": sorted_entries,
    }


def serialize(doc):
    # Stable, sorted-keys, 2-space indent, trailing newline: matches repo JSON style and guarantees
    # byte-identity across runs with identical data.
    return json.dumps(doc, indent=2, sort_keys=True) + "\n"


def main():
    today = today_utc()

    # CLI overrides for local runs / tests: argv[2]=litellm, argv[3]=current, argv[4]=ledger out.
    litellm_path = sys.argv[2] if len(sys.argv) > 2 else None
    current_path = sys.argv[3] if len(sys.argv) > 3 else CURRENT_PATH
    ledger_path = sys.argv[4] if len(sys.argv) > 4 else LEDGER_PATH

    with open(current_path) as f:
        current = json.load(f)
    if litellm_path:
        with open(litellm_path) as f:
            litellm = json.load(f)
    else:
        # Default to a sibling litellm.json the workflow has already fetched.
        with open(os.path.join(os.getcwd(), "litellm.json")) as f:
            litellm = json.load(f)

    observed = build_observed(current, litellm)
    ledger = load_ledger(ledger_path)
    entries = upsert(ledger, observed, today)
    doc = build_document(entries, today)
    out = serialize(doc)

    before = None
    if os.path.exists(ledger_path):
        with open(ledger_path) as f:
            before = f.read()

    changed = before != out
    if changed:
        os.makedirs(os.path.dirname(ledger_path), exist_ok=True)
        with open(ledger_path, "w") as f:
            f.write(out)

    s = doc["summary"]
    print(
        f"litellm-ledger: today={today} open={s['open_count']} resolved={s['resolved_count']} "
        f"oldest_open_days={s['oldest_open_days']} changed={'yes' if changed else 'no'}"
    )
    # Machine-readable change flag for the workflow's commit-only-when-changed step.
    print(f"LEDGER_CHANGED={'1' if changed else '0'}")


if __name__ == "__main__":
    main()
