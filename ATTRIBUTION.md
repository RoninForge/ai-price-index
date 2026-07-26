# How to attribute the AI Price Index

The data in this repository is licensed [CC BY 4.0](DATA-LICENSE.md). You can use it anywhere,
including commercially, for free. The one thing the licence asks is credit.

Credit belongs to the dataset's home page, **<https://roninforge.org/data/ai-price-index/>**, not to
this repository. The page is the canonical record: it carries the methodology, the source list, the
validation dates and the changelog, and it stays correct if the code moves. This repository is the
build system that produces the data.

Pick whichever format fits your medium. All of them satisfy the licence.

## Plain text

```
AI Price Index by RoninForge (https://roninforge.org/data/ai-price-index/), CC BY 4.0.
Values validated <date>.
```

## Markdown

```markdown
[AI Price Index](https://roninforge.org/data/ai-price-index/) by RoninForge, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Values validated <date>.
```

## HTML

```html
<p>
  Price data from
  <a href="https://roninforge.org/data/ai-price-index/">AI Price Index</a>
  by RoninForge, licensed
  <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>.
  Values validated <date>.
</p>
```

## Academic and archival

Cite the DOI so your snapshot stays reproducible. Machine-readable metadata lives in
[`CITATION.cff`](CITATION.cff).

```
AI Price Index by RoninForge (https://roninforge.org/data/ai-price-index/), CC BY 4.0.
Release <tag>, accessed <date>. https://doi.org/10.5281/zenodo.20730240
```

```bibtex
@misc{roninforge_ai_price_index,
  author       = {{RoninForge}},
  title        = {{AI Price Index: dated, first-party AI model API prices over time}},
  howpublished = {\url{https://roninforge.org/data/ai-price-index/}},
  doi          = {10.5281/zenodo.20730240},
  note         = {Release <tag>. Data licensed CC BY 4.0. Accessed <date>.}
}
```

`10.5281/zenodo.20730240` is the **concept DOI**: it always resolves to the latest version. Every
release also mints a version DOI if you need to pin an exact snapshot.

## Why the validation date matters

Prices change, and this dataset supersedes values without deleting history. A citation without a date
tells your reader which numbers you used but not when they were true. Because every record carries an
`effective_from` and `effective_to`, a dated citation stays checkable years later. That is the whole
point of a bitemporal ledger, so please keep the date in.

## What attribution does not require

You do not need permission, a licence fee, a link back from us, or notice of your use. You do not
need to share your derived work under the same licence. CC BY has no share-alike clause.

If you have built something with this data we would like to see it, but that is a request, not a
condition.
