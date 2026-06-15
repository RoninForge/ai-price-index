# Backfill log: Anthropic (Claude)

Historical price reconstruction for Anthropic Claude models, flagship-first. Every record is backed
by a fetched first-party announcement and/or a Wayback Machine capture of the Anthropic pricing page,
with the capture timestamp recorded as `source_snapshot_ts` and `last_validated_at` set to the
evidence date. Confidence is `archived` (confirmed from a dated archive). Prices are USD per 1M tokens.

## What was added (2026-06-14, verified against the sources below)

| model | input | output | effective_from | effective_to (retired) | evidence |
| --- | --- | --- | --- | --- | --- |
| claude-3-opus-20240229 | 15 | 75 | 2024-03-04 | 2026-01-05 | Wayback /api 20240304143754 + news/claude-3-family |
| claude-3-sonnet-20240229 | 3 | 15 | 2024-03-04 | 2025-07-21 | same launch-day capture |
| claude-3-haiku-20240307 | 0.25 | 1.25 | 2024-03-04 | 2026-04-20 | same launch-day capture (model GA mid-March 2024) |
| claude-3-5-sonnet-20240620 | 3 | 15 | 2024-06-20 | 2025-10-28 | Wayback /pricing 20240624062926 + news/claude-3-5-sonnet |
| claude-3-5-haiku-20241022 | 1 -> 0.80 | 5 -> 4 | 2024-11-04 -> 2024-12-03 | 2026-02-19 | a real two-step price change, both stated in news/3-5-models-and-computer-use |
| claude-3-7-sonnet-20250219 | 3 | 15 | 2025-02-24 | 2026-02-19 | Wayback /pricing 20250224210640 + news/claude-3-7-sonnet |

The current models (Opus 4, Opus 4.5, Sonnet 4.5, and Fable 5) were seeded from the live pricing page.
Fable 5 (`claude-fable-5`, $10/$50, Anthropic's first public Mythos-class model) launched 2026-06-09;
the listed API rate is free for subscription plans through 2026-06-22, standard metered from 2026-06-23.

## Notable findings

- **Claude 3.5 Haiku launched at a 4x premium over Claude 3 Haiku** ($1/$5 vs $0.25/$1.25) on
  2024-11-04, then was cut to $0.80/$4 on 2024-12-03. Both revisions are stated verbatim in
  Anthropic's own announcement post; the $1/$5 launch figure was confirmed from a pre-Dec-3 Wayback
  snapshot of that post. This is recorded as two intervals on one model, so the chart shows a step.
- **The Opus flagship input price held at $15 from Claude 3 Opus (Mar 2024) through Opus 4 (May 2025),
  then dropped to $5 with Opus 4.5 (Nov 2025).**
- **Sonnet held at $3/$15** across Claude 3 Sonnet, 3.5 Sonnet, 3.7 Sonnet, and Sonnet 4.5.

## Retirement dates

`effective_to` for each retired model is its full-shutdown (retired) date from Anthropic's official
model-deprecations page, so the chart line ends when the model stopped being offered rather than
running to "now". The deprecations page note applies: these dates are for Anthropic-operated
platforms; partner platforms (Bedrock, Vertex) set their own.

## Sources fetched

- https://www.anthropic.com/news/claude-3-family
- https://www.anthropic.com/news/claude-3-5-sonnet
- https://www.anthropic.com/news/3-5-models-and-computer-use
- https://www.anthropic.com/news/claude-3-7-sonnet
- https://web.archive.org/web/20240304143754/https://www.anthropic.com/api
- https://web.archive.org/web/20240624062926/https://www.anthropic.com/pricing
- https://web.archive.org/web/20241105102333/https://www.anthropic.com/news/3-5-models-and-computer-use
- https://web.archive.org/web/20241203010242/https://www.anthropic.com/pricing
- https://web.archive.org/web/20250224210640/https://www.anthropic.com/pricing
- https://platform.claude.com/docs/en/about-claude/model-deprecations

## Caveats and method

- Prices come from Anthropic's published pricing pages and announcement posts (not API output), via
  the Wayback Machine where the live page no longer shows the historical value.
- Effective dates are the announced availability dates; where a model's snapshot id encodes a slightly
  different date, the announced/availability date is used and noted.
- This is the first backfill pass (Claude flagships). It deepens as more captures are reviewed and
  more providers are added. Corrections supersede in the bitemporal store; nothing is overwritten.
