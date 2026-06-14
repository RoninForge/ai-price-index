# Isolated runtime for the ai-price-index system-of-record tooling.
# The tooling is stdlib-only Python (no pip install), so the image is just a pinned interpreter;
# the repo is bind-mounted at /work at run time (see docker-compose.yml). This keeps the DB jobs
# isolated and reproducible without installing Node or building native modules on the VPS host.
FROM python:3.12-slim
WORKDIR /work
ENTRYPOINT ["python"]
