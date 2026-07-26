/**
 * core/src/schema.ts: whole-page design reference for redesign prompts.
 *
 * A thin wrapper over the page-schema inspector: design tokens (color palette ranked
 * by usage, font scale, spacing rhythm, radii, shadows) and a section blueprint with
 * grid/flex, column counts, and max-widths. The schema is the whole payload; component
 * samples are deliberately excluded so schema.md stays small enough for an agent to
 * read in one pass. An agent that wants a concrete sample runs extract on one element.
 *
 * Async because the extractor recovers cross-origin stylesheets through the Host, which is
 * where a cdn-served site keeps its hover rules and breakpoints.
 */
import type { PageSchema } from './inspect/schema/types';
import { extractPageSchema } from './inspect/schema/extract';
import { optimizeSchema } from './inspect/schema/optimize';

/** The full schema payload the runner writes to schema.json. */
export interface SchemaResult {
	schema: PageSchema;
}

/** Builds the whole-page schema: design tokens and layout from the inspector. */
export async function buildSchema(): Promise<SchemaResult> {
	return { schema: optimizeSchema(await extractPageSchema()) };
}
