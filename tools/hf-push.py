#!/usr/bin/env python3
"""Push dist/hf/ to the Hugging Face dataset RoninForge/ai-price-index.

Run after tools/hf-export.mjs. Requires HF_TOKEN env (a token with WRITE access to
the dataset repo). upload_folder skips the commit when nothing changed, so a no-op
run produces no Hugging Face commit. GITHUB_SHA, when present, is folded into the
commit message for traceability.
"""
import os
import sys

from huggingface_hub import HfApi

token = os.environ.get("HF_TOKEN")
if not token:
    sys.exit("HF_TOKEN env var is not set")

sha = os.environ.get("GITHUB_SHA", "")
msg = "Sync from ai-price-index" + (f" ({sha[:7]})" if sha else "")

api = HfApi(token=token)
info = api.upload_folder(
    folder_path="dist/hf",
    repo_id="RoninForge/ai-price-index",
    repo_type="dataset",
    commit_message=msg,
)
print("upload result:", getattr(info, "commit_url", info))
