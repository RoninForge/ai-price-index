// Type declarations for ai-price-index.

export interface PriceInterval {
	/** Valid-time start (inclusive), ISO YYYY-MM-DD. */
	from: string;
	/** Valid-time end (exclusive), or null if still current. */
	to: string | null;
	price_usd: number;
	unit: string;
	last_validated?: string;
	confidence?: string;
	/** First-party source URL. */
	src?: string;
	snapshot?: string;
}

export interface ModelSeries {
	model: string;
	provider: string;
	aliases?: string[];
	variations: {
		input: PriceInterval[];
		output: PriceInterval[];
		[variation: string]: PriceInterval[];
	};
}

export interface PriceBundle {
	schemaVersion: string;
	dataModified: string;
	license: string;
	doi: string;
	attribution: string;
	source: { repo: string; ref: string; sha: string; dataPage: string };
	sources: string[];
	series: ModelSeries[];
	current: unknown[];
}

export interface IntervalView {
	price_usd: number;
	unit: string;
	from: string;
	to: string | null;
	last_validated: string | null;
	confidence: string | null;
	source: string | null;
}

export interface PriceResult {
	query: string;
	provider: string;
	model: string;
	aliases: string[];
	date: string;
	covered: boolean;
	input: IntervalView | null;
	output: IntervalView | null;
}

export interface ResolveResult {
	provider: string;
	model: string;
	aliases: string[];
	series: ModelSeries;
}

export interface TokenRollup {
	input?: number;
	output?: number;
	cache_read?: number;
	cache_write_5m?: number;
	cache_write_1h?: number;
}

export interface ResolveOpts {
	provider?: string;
}

export const bundle: PriceBundle;
export const meta: {
	schemaVersion: string;
	dataModified: string;
	license: string;
	doi: string;
	attribution: string;
	source: PriceBundle['source'];
};

export const CACHE_READ_MULT: number;
export const CACHE_WRITE_5M_MULT: number;
export const CACHE_WRITE_1H_MULT: number;

export function providers(): string[];
export function models(): Array<{ provider: string; model: string; aliases: string[] }>;
export function candidates(model: string): ModelSeries[];
export function resolve(model: string, opts?: ResolveOpts): ResolveResult | null;

export function priceOn(model: string): PriceResult | null;
export function priceOn(model: string, date: string, opts?: ResolveOpts): PriceResult | null;
export function priceOn(model: string, opts: ResolveOpts): PriceResult | null;

export function current(model: string, opts?: ResolveOpts): PriceResult | null;

export function rate(
	model: string,
	date?: string,
	opts?: ResolveOpts
): { provider: string; model: string; date: string; inputPerM: number; outputPerM: number } | null;

export function rateAt(
	provider: string,
	model: string,
	date: string
): { inputPerM: number; outputPerM: number } | null;

export function usdForRollup(
	tokens: TokenRollup,
	provider: string,
	model: string,
	date: string
): { cents: number; modelKnown: boolean };

export function usdForRollupRaw(
	tokens: TokenRollup,
	provider: string,
	model: string,
	date: string
): { usd: number; modelKnown: boolean };

declare const _default: {
	meta: typeof meta;
	bundle: PriceBundle;
	providers: typeof providers;
	models: typeof models;
	candidates: typeof candidates;
	resolve: typeof resolve;
	priceOn: typeof priceOn;
	current: typeof current;
	rate: typeof rate;
	rateAt: typeof rateAt;
	usdForRollup: typeof usdForRollup;
	usdForRollupRaw: typeof usdForRollupRaw;
};
export default _default;
