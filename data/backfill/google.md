# Backfill log: Google (Gemini)

Gemini API price history, reconstructed from Google developer-blog announcements plus archived
ai.google.dev pricing pages (Wayback). Prices are USD per 1M tokens, base/standard tier.

| model | input | output | effective_from | effective_to | evidence |
| --- | --- | --- | --- | --- | --- |
| gemini-1.5-flash | 0.075 | 0.30 | 2024-08-12 | null | Wayback ai.google.dev/pricing 20241001092414 + blog |
| gemini-1.5-pro | 1.25 | 5.00 | 2024-10-01 | null | Wayback 20241001092414 (Oct 1 cut from 3.50/10.50) |
| gemini-2.0-flash | 0.10 | 0.40 | 2025-02-05 | 2026-06-01 | Wayback 20250211215432; shut down 2026-06-01 |
| gemini-2.5-pro | 1.25 | 10.00 | 2025-06-17 | null | Wayback 20250621161929 |
| gemini-2.5-flash | 0.30 | 2.50 | 2025-06-17 | null | Wayback 20250621161929 |
| gemini-2.5-flash-lite | 0.10 | 0.40 | 2025-06-17 | null | Wayback 20250621161929 |

## Tiered-context caveat (important)

Gemini Pro models price by prompt size. The recorded value is the BASE tier: prompts <=128k for the
1.5 line, <=200k for 2.5 Pro. Above the threshold the rate is higher (e.g. 2.5 Pro >200k was
2.50/15.00). The Flash / Flash-Lite lines are flat on context but have a modality split; the recorded
input is text/image/video, and audio input is higher. These caveats are in each record's note.

## Caveats / gaps

- `effective_to` is set only for models already retired. gemini-2.0-flash shut down 2026-06-01 (a past
  date as of this writing), so its line ends there; the others stay `null`.
- Two genuine price cuts are well-sourced: Gemini 1.5 Flash (Aug 2024) and Gemini 1.5 Pro (Oct 1 2024,
  3.50/10.50 -> 1.25/5.00). The pre-cut values are stated in the captures but their exact start dates
  were not sourced, so only the post-cut dated values are recorded (the pre-cut step is noted, not
  charted).
- The current Gemini 3.x line (3.1 Pro, 3.5 Flash, 3.1 Flash-Lite) is priced on the live page and
  tracked in the llm-pricing dataset, but first-party effective dates were not sourceable, so it is
  NOT yet in the index. gemini-2.5-pro (still live) carries the line to the present.

## Sources fetched

- https://web.archive.org/web/20241001092414/https://ai.google.dev/pricing
- https://web.archive.org/web/20250211215432/https://ai.google.dev/pricing
- https://web.archive.org/web/20250621161929/https://ai.google.dev/gemini-api/docs/pricing
- https://developers.googleblog.com/en/updated-gemini-models-reduced-15-pro-pricing-increased-rate-limits-and-more/
- https://developers.googleblog.com/en/gemini-2-family-expands/
- https://developers.googleblog.com/en/gemini-2-5-thinking-model-updates/
- https://ai.google.dev/gemini-api/docs/pricing (current live page)
