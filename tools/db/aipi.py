#!/usr/bin/env python3
"""ai-price-index system-of-record tooling (MIT).

Stdlib only (sqlite3, json, hashlib, uuid, argparse, datetime); runs on the VPS host python3.12
or in the python:3.12-slim container, and is tested on 3.9. The SQLite DB is the system of record;
the export writes the static, served artifacts.

Commands:
  init     apply the bitemporal schema (idempotent; sets WAL).
  seed     load data/records/*.json into price_records (insert new, supersede on a changed value).
  export   write the published artifacts (index.json, current.json, per-model series files).
  stats    print row counts (a quick health check).

Run from the repo root, e.g.:
  python tools/db/aipi.py init
  python tools/db/aipi.py seed
  python tools/db/aipi.py export
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import uuid
from datetime import datetime, timezone

REQUIRED = (
    "provider", "model_id", "variation", "unit", "price_usd",
    "effective_from", "last_validated_at", "source_url", "source_kind", "confidence"
)
SCHEMA_VERSION = "1.0.0"
LICENSE = "CC-BY-4.0"


def now_iso(arg):
    if arg:
        return arg
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def connect(db_path):
    d = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(d, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON;")
    return con


def cmd_init(args):
    con = connect(args.db)
    with open(args.schema, "r", encoding="utf-8") as f:
        con.executescript(f.read())
    con.commit()
    mode = con.execute("PRAGMA journal_mode;").fetchone()[0]
    con.close()
    print("init ok: schema applied to %s (journal_mode=%s)" % (args.db, mode))


def load_record_files(records_dir):
    out = []
    for root, _dirs, files in os.walk(records_dir):
        for name in sorted(files):
            if not name.endswith(".json"):
                continue
            path = os.path.join(root, name)
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, list):
                raise SystemExit("records file %s must be a JSON array" % path)
            for i, r in enumerate(data):
                missing = [k for k in REQUIRED if k not in r or (r[k] in (None, "") and r[k] != 0)]
                if missing:
                    raise SystemExit("%s[%d] missing required: %s" % (path, i, ", ".join(missing)))
                out.append((path, i, r))
    return out


def cmd_seed(args):
    con = connect(args.db)
    recorded_at = now_iso(args.now)
    records = load_record_files(args.records_dir)
    inserted = superseded = unchanged = 0
    for _path, _i, r in records:
        existing = con.execute(
            "SELECT record_id, price_usd, unit, source_url, last_validated_at, effective_to, confidence "
            "FROM price_records WHERE superseded_at IS NULL "
            "AND provider=? AND model_id=? AND variation=? AND effective_from=?",
            (r["provider"], r["model_id"], r["variation"], r["effective_from"]),
        ).fetchone()

        if existing is not None:
            same = (
                float(existing["price_usd"]) == float(r["price_usd"])
                and existing["unit"] == r["unit"]
                and existing["source_url"] == r["source_url"]
                and existing["last_validated_at"] == r["last_validated_at"]
                and (existing["effective_to"] or None) == (r.get("effective_to") or None)
                and existing["confidence"] == r["confidence"]
            )
            if same:
                unchanged += 1
                continue
            con.execute(
                "UPDATE price_records SET superseded_at=? WHERE record_id=?",
                (recorded_at, existing["record_id"]),
            )
            supersedes_id = existing["record_id"]
            change_reason = "correction"
            superseded += 1
        else:
            supersedes_id = None
            change_reason = "initial"
            inserted += 1

        con.execute(
            "INSERT INTO price_records (record_id, provider, model_id, variation, unit, price_usd, "
            "effective_from, effective_to, recorded_at, superseded_at, last_validated_at, source_url, "
            "source_kind, source_snapshot_ts, confidence, supersedes_id, change_reason, recorded_by) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                str(uuid.uuid4()), r["provider"], r["model_id"], r["variation"], r["unit"], float(r["price_usd"]),
                r["effective_from"], r.get("effective_to"), recorded_at, None, r["last_validated_at"], r["source_url"],
                r["source_kind"], r.get("source_snapshot_ts"), r["confidence"], supersedes_id, change_reason, args.recorded_by,
            ),
        )
    con.commit()
    con.close()
    print("seed ok: %d inserted, %d superseded (corrections), %d unchanged" % (inserted, superseded, unchanged))


def cmd_export(args):
    con = connect(args.db)
    rows = con.execute(
        "SELECT provider, model_id, variation, unit, price_usd, effective_from, effective_to, "
        "last_validated_at, source_url, source_snapshot_ts, confidence "
        "FROM price_records WHERE superseded_at IS NULL "
        "ORDER BY provider, model_id, variation, effective_from"
    ).fetchall()
    con.close()

    models = {}
    for r in rows:
        key = (r["provider"], r["model_id"])
        iv = {
            "from": r["effective_from"],
            "to": r["effective_to"],
            "price_usd": r["price_usd"],
            "unit": r["unit"],
            "last_validated": r["last_validated_at"],
            "confidence": r["confidence"],
            "src": r["source_url"],
        }
        if r["source_snapshot_ts"]:
            iv["snapshot"] = r["source_snapshot_ts"]
        models.setdefault(key, {}).setdefault(r["variation"], []).append(iv)

    out = args.out_dir
    models_dir = os.path.join(out, "models")
    if os.path.isdir(models_dir):
        shutil.rmtree(models_dir)
    os.makedirs(models_dir, exist_ok=True)

    index_models = []
    current = []
    for (provider, model_id), variations in sorted(models.items()):
        content = {"model": model_id, "provider": provider, "variations": variations}
        blob = json.dumps(content, sort_keys=True, separators=(",", ":")).encode("utf-8")
        digest = hashlib.sha256(blob).hexdigest()[:8]
        rel = "models/%s/%s.v%s.json" % (provider, model_id, digest)
        abspath = os.path.join(out, rel)
        os.makedirs(os.path.dirname(abspath), exist_ok=True)
        with open(abspath, "w", encoding="utf-8") as f:
            json.dump(content, f, indent=2, sort_keys=True)
            f.write("\n")
        index_models.append({"id": model_id, "provider": provider, "file": rel, "latestRev": digest})

        for variation, ivs in variations.items():
            cur_iv = next((iv for iv in ivs if iv["to"] is None), None)
            if cur_iv is None:
                cur_iv = max(ivs, key=lambda x: x["from"])
            current.append({
                "provider": provider, "model": model_id, "variation": variation,
                "price_usd": cur_iv["price_usd"], "unit": cur_iv["unit"],
                "last_validated": cur_iv["last_validated"], "confidence": cur_iv["confidence"],
                "src": cur_iv["src"],
            })

    # dataModified is derived from the DATA (the latest validation date), not the wall clock, so a
    # re-export is byte-identical unless the data actually changed. That keeps the daily publish cron
    # from committing on every run, and maps cleanly onto Dataset JSON-LD dateModified at step 5.
    data_modified = max((r["last_validated_at"] for r in rows), default="1970-01-01")
    index = {
        "schemaVersion": SCHEMA_VERSION, "dataModified": data_modified, "license": LICENSE,
        "models": index_models,
    }
    with open(os.path.join(out, "index.json"), "w", encoding="utf-8") as f:
        json.dump(index, f, indent=2)
        f.write("\n")

    current.sort(key=lambda x: (x["provider"], x["model"], x["variation"]))
    with open(os.path.join(out, "current.json"), "w", encoding="utf-8") as f:
        json.dump({
            "schemaVersion": SCHEMA_VERSION, "dataModified": data_modified, "license": LICENSE,
            "prices": current,
        }, f, indent=2)
        f.write("\n")

    print("export ok: %d models, %d current prices -> %s" % (len(index_models), len(current), out))


def cmd_stats(args):
    con = connect(args.db)
    total = con.execute("SELECT COUNT(*) FROM price_records").fetchone()[0]
    current = con.execute("SELECT COUNT(*) FROM price_records WHERE superseded_at IS NULL").fetchone()[0]
    models = con.execute(
        "SELECT COUNT(DISTINCT provider || '/' || model_id) FROM price_records WHERE superseded_at IS NULL"
    ).fetchone()[0]
    con.close()
    print("stats: %d total records, %d current, %d models" % (total, current, models))


def main():
    p = argparse.ArgumentParser(description="ai-price-index system-of-record tooling")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--db", default="db/ai-price-index.db")
    sub = p.add_subparsers(dest="cmd", required=True)

    pi = sub.add_parser("init", parents=[common])
    pi.add_argument("--schema", default="db/schema.sql")
    pi.set_defaults(func=cmd_init)

    ps = sub.add_parser("seed", parents=[common])
    ps.add_argument("--records-dir", default="data/records")
    ps.add_argument("--recorded-by", default="seed")
    ps.add_argument("--now", default=None)
    ps.set_defaults(func=cmd_seed)

    pe = sub.add_parser("export", parents=[common])
    pe.add_argument("--out-dir", default="data/ai-price-index")
    pe.add_argument("--now", default=None)
    pe.set_defaults(func=cmd_export)

    pt = sub.add_parser("stats", parents=[common])
    pt.set_defaults(func=cmd_stats)

    args = p.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
