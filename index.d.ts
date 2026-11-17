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
): { inputPerM: number; outputPerM: number; cacheReadPerM: number } | null;

/** The prompt-length tier (tier2_*) rates in effect on `date`, or null when the model has none. */
export function tier2RateAt(
	provider: string,
	model: string,
	date: string
): { inputPerM: number; outputPerM: number; cacheReadPerM: number } | null;

/** Prompt size for prompt-length tiers: input + cache_read + cache_write_5m + cache_write_1h. */
export function promptTokens(tokens: TokenRollup): number;

/** Prompt size above which a provider bills a request at its tier2 rates (anthropic: 100000). */
export const PROMPT_TIER_THRESHOLDS: Readonly<Record<string, number>>;

/** Values a rollup at the base tier; a lower bound for a model with a prompt-length tier. */
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

/** Values ONE request; a prompt over the provider's threshold bills at the tier2 rates (tier2: true). */
export function usdForRequest(
	tokens: TokenRollup,
	provider: string,
	model: string,
	date: string
): { cents: number; modelKnown: boolean; tier2: boolean };

export function usdForRequestRaw(
	tokens: TokenRollup,
	provider: string,
	model: string,
	date: string
): { usd: number; modelKnown: boolean; tier2: boolean };

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
	tier2RateAt: typeof tier2RateAt;
	promptTokens: typeof promptTokens;
	usdForRollup: typeof usdForRollup;
	usdForRollupRaw: typeof usdForRollupRaw;
	usdForRequest: typeof usdForRequest;
	usdForRequestRaw: typeof usdForRequestRaw;
};
export default _default;
