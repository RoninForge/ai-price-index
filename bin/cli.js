#!/usr/bin/env node
// CLI for ai-price-index. Prints the AI model API rate that was in effect on a given date, with its
// first-party source. No network: reads the bundle shipped in the package.
//
//   npx ai-price-index claude-opus-4-8                 today's rate
//   npx ai-price-index gpt-4 --on 2024-01-01           the rate in effect on a past date
//   npx ai-price-index command-r --provider cohere     disambiguate a bare model id
//   npx ai-price-index list [--provider openai]        list known models
//   npx ai-price-index providers                       list providers
//   add --json to any command for machine-readable output
import { readFileSync } from 'node:fs';
import { priceOn, models, providers, meta } from '../lib/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function parseArgs(argv) {
	const opts = { _: [], json: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--json') opts.json = true;
		else if (a === '--on' || a === '--date') opts.on = argv[++i];
		else if (a.startsWith('--on=')) opts.on = a.slice(5);
		else if (a === '--provider' || a === '-p') opts.provider = argv[++i];
		else if (a.startsWith('--provider=')) opts.provider = a.slice(11);
		else if (a === '--help' || a === '-h') opts.help = true;
		else if (a === '--version' || a === '-v') opts.version = true;
		else opts._.push(a);
	}
	return opts;
}

const HELP = `ai-price-index - open, dated AI model API prices with first-party sources.

Usage:
  ai-price-index <model> [--on YYYY-MM-DD] [--provider <slug>] [--json]
  ai-price-index list [--provider <slug>] [--json]
  ai-price-index providers [--json]

Options:
  --on YYYY-MM-DD   the date to price (default: today)
  --provider <slug> disambiguate a bare model id (e.g. anthropic, openai, google)
  --json            machine-readable output
  -v, --version     print version and dataset date
  -h, --help        this help

Data CC BY 4.0, tooling MIT. Source: ${meta.source.dataPage}`;

function fmtPrice(iv) {
	if (!iv) return 'n/a';
	return `$${iv.price_usd}/${iv.unit.replace('usd_per_', '')}`;
}

function printModel(query, opts) {
	let res;
	try {
		res = priceOn(query, opts.on, opts.provider ? { provider: opts.provider } : {});
	} catch (err) {
		// Ambiguous bare id: surface the candidates.
		console.error(err.message);
		process.exit(2);
	}

	if (!res) {
		console.error(
			`Unknown model "${query}". Try: ai-price-index list${opts.provider ? ` --provider ${opts.provider}` : ''}`
		);
		process.exit(1);
	}

	if (opts.json) {
		process.stdout.write(JSON.stringify(res, null, 2) + '\n');
		return;
	}

	if (!res.covered) {
		console.log(
			`${res.provider}/${res.model}: no priced record on ${res.date} (dataset coverage may start later).`
		);
		return;
	}

	const lines = [
		`${res.provider}/${res.model}${res.model !== query ? `  (resolved from "${query}")` : ''}`,
		`  date     ${res.date}`,
		`  input    ${fmtPrice(res.input)}`,
		`  output   ${fmtPrice(res.output)}`
	];
	const src = res.input?.source || res.output?.source;
	const conf = res.input?.confidence || res.output?.confidence;
	const val = res.input?.last_validated || res.output?.last_validated;
	if (conf) lines.push(`  confidence ${conf}${val ? `, validated ${val}` : ''}`);
	if (src) lines.push(`  source   ${src}`);
	console.log(lines.join('\n'));
}

function printList(opts) {
	let list = models();
	if (opts.provider) list = list.filter((m) => m.provider === opts.provider);
	if (opts.json) {
		process.stdout.write(JSON.stringify(list, null, 2) + '\n');
		return;
	}
	if (!list.length) {
		console.error(`No models${opts.provider ? ` for provider "${opts.provider}"` : ''}.`);
		process.exit(1);
	}
	for (const m of list) {
		const alias = m.aliases.length ? `  (aliases: ${m.aliases.join(', ')})` : '';
		console.log(`${m.provider}/${m.model}${alias}`);
	}
}

function printProviders(opts) {
	const list = providers();
	if (opts.json) {
		process.stdout.write(JSON.stringify(list, null, 2) + '\n');
		return;
	}
	console.log(list.join('\n'));
}

function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.version) {
		console.log(`ai-price-index ${pkg.version} (dataset ${meta.dataModified}, ${meta.source.ref})`);
		return;
	}
	if (opts.help || opts._.length === 0) {
		console.log(HELP);
		return;
	}
	const [cmd, ...rest] = opts._;
	if (cmd === 'list') return printList(opts);
	if (cmd === 'providers') return printProviders(opts);
	// Default: treat the first positional as a model id.
	if (rest.length) {
		console.error(`Unexpected extra arguments: ${rest.join(' ')}`);
		process.exit(2);
	}
	return printModel(cmd, opts);
}

main();
