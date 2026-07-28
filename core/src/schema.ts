/**
 * core/src/schema.ts: the schema command's entry point.
 *
 * Runs the page-scoped inspect pass and returns the optimized PageSchema. The extraction
 * itself is inspect/schema/extract.ts; this is the seam the runner drives.
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
