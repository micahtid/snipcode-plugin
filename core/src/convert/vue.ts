/**
 * convert/vue.ts: vue single-file component output.
 *
 * Runs in convert, on the bem emitter's output. A vue template is html, where class stays
 * class unlike jsx, so this reuses the bem markup and stylesheet and wraps them in <template>
 * and <style scoped>. A vue template needs one root element, which the snip root provides.
 */
import type { Captured } from '../types';
import { emitBem } from './bem';
import type { HtmlOutput } from './document';

/**
 * Emits the snip as a vue sfc: template plus scoped style.
 *
 * @returns html = the .vue file contents, css = the stylesheet, which is also embedded
 */
export function emitVue(captured: Captured): HtmlOutput {
	const base = emitBem(captured);
	const template = indent(base.html, 1);
	const style = base.css.trim() ? `\n\n<style scoped>\n${base.css}\n</style>` : '';
	const sfc = `<template>\n${template}\n</template>${style}`;
	return { html: sfc, css: base.css };
}

/** Indent every line of `text` by `levels` tabs. */
function indent(text: string, levels: number): string {
	const pad = '\t'.repeat(levels);
	return text
		.split('\n')
		.map((line) => (line ? pad + line : line))
		.join('\n');
}
