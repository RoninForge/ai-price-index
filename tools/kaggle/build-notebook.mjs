#!/usr/bin/env node
// Builds a Kaggle starter notebook (dist/kaggle/starter.ipynb) for the AI Price Index dataset.
// The notebook loads the data at runtime from the attached Kaggle input, so it needs no local data.
// Run: node tools/kaggle/build-notebook.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'dist', 'kaggle');
mkdirSync(outDir, { recursive: true });

// Cells, in order. md = markdown, code = python.
const cells = [
	['md', `# How AI API prices fanned out

A starter notebook for the [AI Price Index](https://www.kaggle.com/datasets/roninforge/ai-price-index): an open, dated, first-party-sourced record of AI model API prices over time.

The common story is that AI gets about 10x cheaper every year. The data tells a more interesting one: prices did not fall in a line, they **fanned out**. This notebook reproduces that from the raw data in a few cells.

Full write-up with the chart: https://roninforge.org/data/ai-price-index/the-fan-out/`],

	['code', `import glob
import pandas as pd

# The dataset is attached under /kaggle/input/. Glob keeps this robust to the exact mount path.
path = glob.glob("/kaggle/input/**/ai_price_index.csv", recursive=True)[0]
df = pd.read_csv(path)
print(df.shape[0], "price records,", df["model_id"].nunique(), "models,", df["provider"].nunique(), "providers")

# Empty cells read as NaN: an empty effective_to means the price is still current, and an empty
# aliases means the model has no alternate ids. Shown blank below just for readability.
df.head().fillna("")`],

	['md', `## 1. There is no single "price of AI"

Filter to current prices (rows where \`effective_to\` is empty) and compare the cheapest and most expensive model for each token type.`],

	['code', `current = df[df["effective_to"].isna()]

for var in ["input", "output"]:
    c = current[current["variation"] == var].sort_values("price_usd")
    lo, hi = c.iloc[0], c.iloc[-1]
    spread = hi["price_usd"] / lo["price_usd"]
    print(f"{var:>6}:  cheapest  \${lo['price_usd']:<8} {lo['provider']}/{lo['model_id']}")
    print(f"         priciest  \${hi['price_usd']:<8} {hi['provider']}/{hi['model_id']}")
    print(f"         -> {spread:,.0f}x spread, same unit, same day\\n")`],

	['md', `## 2. The fan-out

Plot every model's input price against the date it took effect, on a log scale. The cloud starts tight near \\$30 in 2023 and opens into several orders of magnitude. The dashed line is the cheapest input price available at any point in time.`],

	['code', `import matplotlib.pyplot as plt

inp = df[df["variation"] == "input"].copy()
inp["effective_from"] = pd.to_datetime(inp["effective_from"])

fig, ax = plt.subplots(figsize=(11, 6))
for provider, s in inp.groupby("provider"):
    ax.scatter(s["effective_from"], s["price_usd"], s=30, alpha=0.75, label=provider)

# Cheapest-input-over-time floor (a descending step line through the cloud).
floor = inp.sort_values("effective_from")
run_min, xs, ys = float("inf"), [], []
for _, r in floor.iterrows():
    if r["price_usd"] < run_min:
        run_min = r["price_usd"]
        xs.append(r["effective_from"])
        ys.append(run_min)
ax.step(xs, ys, where="post", color="black", lw=1.5, ls="--", label="cheapest available")

ax.set_yscale("log")
ax.set_ylabel("Input price (USD per 1M tokens, log scale)")
ax.set_title("AI input prices fanned out, 2023 to 2026")
ax.legend(ncol=2, fontsize=8)
plt.tight_layout()
plt.show()`],

	['md', `## 3. Point-in-time pricing: what a job actually cost on the day

Because every price is dated, you can price a historical workload at the rate that was really in effect, not today's rate. Here is a 10M-input / 2M-output job (a meaty coding-agent day) priced across three models, then and now.`],

	['code', `def price_on(model_id, variation, date):
    """Price of a model+variation in effect on a given date (bitemporal lookup)."""
    d = pd.Timestamp(date)
    rows = df[(df["model_id"] == model_id) & (df["variation"] == variation)].copy()
    rows["ef"] = pd.to_datetime(rows["effective_from"])
    rows["et"] = pd.to_datetime(rows["effective_to"])
    m = rows[(rows["ef"] <= d) & (rows["et"].isna() | (rows["et"] > d))]
    return None if m.empty else float(m.iloc[0]["price_usd"])

def job_cost(model_id, date, m_in=10, m_out=2):
    pin, pout = price_on(model_id, "input", date), price_on(model_id, "output", date)
    return None if pin is None or pout is None else m_in * pin + m_out * pout

print("A 10M-input / 2M-output job:")
print(f"  GPT-4 in June 2023:  \${job_cost('gpt-4', '2023-06-01'):,.2f}")
print(f"  o1-pro today:        \${job_cost('o1-pro', '2026-06-17'):,.2f}")
print(f"  Nova Micro today:    \${job_cost('nova-micro', '2026-06-17'):,.2f}")`],

	['md', `## Use it

- **Current price** of a model: rows where \`effective_to\` is empty.
- **Price on a date** \`d\`: the row where \`effective_from <= d\` and (\`effective_to\` is empty or \`> d\`).
- Every row links its **first-party source** in \`source_url\`.

Data licensed CC BY 4.0. Source of truth, methodology, and corrections: https://github.com/RoninForge/ai-price-index . Citable DOI: 10.5281/zenodo.20730241`]
];

const toSource = (text) => {
	const lines = text.split('\n');
	return lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l));
};

const nb = {
	cells: cells.map(([type, src]) =>
		type === 'md'
			? { cell_type: 'markdown', metadata: {}, source: toSource(src) }
			: { cell_type: 'code', metadata: {}, execution_count: null, outputs: [], source: toSource(src) }
	),
	metadata: {
		kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
		language_info: { name: 'python' }
	},
	nbformat: 4,
	nbformat_minor: 5
};

const outFile = join(outDir, 'starter.ipynb');
writeFileSync(outFile, JSON.stringify(nb, null, 1) + '\n');
console.log('wrote', outFile, `(${nb.cells.length} cells)`);
