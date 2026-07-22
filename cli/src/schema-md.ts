/**
 * cli/src/schema-md.ts: render the page schema as a markdown reference.
 *
 * schema.json is the machine payload; schema.md is the human/prompt-facing summary an
 * agent can drop straight into a redesign prompt. Pure formatting over the schema the
 * inspector produced, defensive about optional fields so a thin page still renders.
 */
import type { PageSchema } from '../../core/src/inspect/schema/types';
import type { SchemaResult } from '../../core/src/schema';

/** Render tokens, layout, and voice samples into one markdown document. */
export function renderSchemaMd(result: SchemaResult): string {
	const { schema, voice } = result;
	const lines: string[] = [];
	const push = (s = '') => lines.push(s);

	push(`# Design reference: ${schema.meta.title || schema.meta.url}`);
	push();
	push(`Source: ${schema.meta.url}  ·  viewport ${schema.meta.viewport.w}x${schema.meta.viewport.h}`);
	push();

	push('## Tokens');
	push();
	renderColors(schema, push);
	renderFonts(schema, push);
	renderScale(schema, push);
	push();

	push('## Layout');
	push();
	renderSections(schema, push);
	push();

	if (voice.length) {
		push('## Voice (representative components)');
		push();
		for (const sample of voice) {
			push(`### ${sample.role}  ·  \`${sample.selector}\``);
			if (!sample.output) {
				push(`_not sampled: ${sample.warnings.join('; ') || 'no output'}_`);
				push();
				continue;
			}
			push('```html');
			push(sample.output.trim());
			push('```');
			push();
		}
	}

	return `${lines.join('\n')}\n`;
}

function renderColors(schema: PageSchema, push: (s?: string) => void): void {
	const colors = schema.tokens.colors ?? [];
	if (!colors.length) return;
	push('**Colors** (ranked by usage)');
	push();
	for (const c of colors.slice(0, 12)) {
		const contexts = c.contexts?.length ? ` — ${c.contexts.slice(0, 3).join(', ')}` : '';
		push(`- \`${c.value}\`  ×${c.count}${contexts}`);
	}
	push();
}

function renderFonts(schema: PageSchema, push: (s?: string) => void): void {
	const fonts = schema.tokens.fonts ?? [];
	if (!fonts.length) return;
	push('**Fonts**');
	push();
	for (const f of fonts.slice(0, 6)) {
		const sizes = f.sizes?.length ? ` sizes ${f.sizes.slice(0, 8).join(', ')}` : '';
		const weights = f.weights?.length ? ` weights ${f.weights.join(', ')}` : '';
		push(`- ${f.family} (${f.usage})${sizes}${weights}`);
	}
	push();
}

function renderScale(schema: PageSchema, push: (s?: string) => void): void {
	const spacing = schema.tokens.spacing ?? [];
	const radii = schema.tokens.radii ?? [];
	const shadows = schema.tokens.shadows ?? [];
	if (spacing.length) push(`**Spacing**: ${spacing.slice(0, 12).join(', ')}`);
	if (radii.length) push(`**Radii**: ${radii.slice(0, 8).join(', ')}`);
	if (shadows.length) push(`**Shadows**: ${shadows.length} distinct`);
	const scale = schema.tokens.scaleAnalysis;
	if (scale) push(`**Type scale**: ${scale.name} (ratio ${scale.ratio}, base ${scale.base}px)`);
}

function renderSections(schema: PageSchema, push: (s?: string) => void): void {
	const sections = schema.sections ?? [];
	if (!sections.length) {
		push('_no section blueprint detected_');
		return;
	}
	for (const s of sections) {
		const bits: string[] = [s.layout];
		if (s.gridColumns) bits.push(`${s.gridColumns} cols`);
		if (s.maxWidth) bits.push(`max ${s.maxWidth}`);
		if (s.gap) bits.push(`gap ${s.gap}`);
		push(`- **${s.type}** (${s.tag}, ${s.alignment}) — ${bits.join(', ')}`);
		if (s.elements?.length) push(`  - elements: ${s.elements.join(' · ')}`);
	}
}
