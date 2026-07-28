/**
 * convert/jsx.ts: html to jsx for react.
 *
 * Runs during the convert phase, on the tailwind emitter's output.
 *
 * Jsx is not html: class becomes className, for becomes htmlFor, hyphenated svg attributes
 * camelCase, and inline style strings become style objects. This rewrites the markup and
 * wraps it in a component. Jsx lets any childless element self-close, so no void-tag list
 * is needed.
 */
import type { Captured } from '../types';
import { emitTailwind } from './tailwind';
import type { HtmlOutput } from './document';
import { parseDeclarations } from '../utils/css-split';

/**
 * The html attributes that rename to a non-camelCase react prop. This is the
 * react dom attribute vocabulary, a finite output-format table, not a hardcoded
 * list of styling properties. Hyphenated svg attrs are handled algorithmically by camelCasing.
 */
const REACT_ATTR: Record<string, string> = {
	class: 'className',
	for: 'htmlFor',
	tabindex: 'tabIndex',
	readonly: 'readOnly',
	maxlength: 'maxLength',
	minlength: 'minLength',
	autocomplete: 'autoComplete',
	autofocus: 'autoFocus',
	contenteditable: 'contentEditable',
	crossorigin: 'crossOrigin',
	enctype: 'encType',
	formaction: 'formAction',
	novalidate: 'noValidate',
	spellcheck: 'spellCheck',
	srcset: 'srcSet',
	colspan: 'colSpan',
	rowspan: 'rowSpan',
	usemap: 'useMap',
};

/**
 * Emits the snip as a react component plus its stylesheet.
 *
 * @param captured - read-only
 */
export function emitJsx(captured: Captured): HtmlOutput {
	const base = emitTailwind(captured);
	const doc = new DOMParser().parseFromString(base.html, 'text/html');
	const root = doc.body.firstElementChild;
	const jsx = root ? elementToJsx(root, 3) : 'null';
	const component = `export default function Snippet() {\n\treturn (\n${jsx}\n\t);\n}`;
	return { html: component, css: base.css };
}

/** Recursively serialize an element, and its children, as indented jsx. */
function elementToJsx(el: Element, depth: number): string {
	const pad = '\t'.repeat(depth);
	const tag = el.tagName.toLowerCase();
	const attrs = attrsToJsx(el);
	const children = childrenToJsx(el, depth + 1);

	// Jsx allows self-closing any childless element, void or not.
	if (children === '') return `${pad}<${tag}${attrs} />`;
	return `${pad}<${tag}${attrs}>\n${children}\n${pad}</${tag}>`;
}

/** Serialize child element + text nodes as jsx, dropping empty whitespace. */
function childrenToJsx(el: Element, depth: number): string {
	const pad = '\t'.repeat(depth);
	const out: string[] = [];
	for (const node of Array.from(el.childNodes)) {
		if (node.nodeType === Node.ELEMENT_NODE) {
			out.push(elementToJsx(node as Element, depth));
		} else if (node.nodeType === Node.TEXT_NODE) {
			const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
			if (text) out.push(`${pad}${escapeJsxText(text)}`);
		}
	}
	return out.join('\n');
}

/** Build the jsx attribute string for an element. */
function attrsToJsx(el: Element): string {
	const parts: string[] = [];
	for (const attr of Array.from(el.attributes)) {
		const name = jsxAttrName(attr.name);
		if (attr.name === 'style') {
			parts.push(`style={{${styleToObject(attr.value)}}}`);
		} else {
			parts.push(`${name}="${escapeAttr(attr.value)}"`);
		}
	}
	return parts.length ? ' ' + parts.join(' ') : '';
}

/** Map an html attribute name to its react prop name. */
function jsxAttrName(name: string): string {
	if (name.startsWith('data-') || name.startsWith('aria-')) return name; // Kept verbatim in react
	const renamed = REACT_ATTR[name];
	if (renamed) return renamed;
	if (name.includes('-')) return camelCase(name); // Svg attrs: stroke-width -> strokeWidth
	return name;
}

/**
 * Convert an inline style string to react style-object entries. The shared top-level split
 * keeps a `;` or `:` inside a url(data:...;base64,) or any other function with its value, so a
 * data-uri background becomes one entry rather than several broken ones.
 */
function styleToObject(style: string): string {
	const entries: string[] = [];
	for (const { prop, value } of parseDeclarations(style)) {
		if (!prop) continue;
		// Custom properties keep their literal name and must be quoted as a key.
		const key = prop.startsWith('--') ? `'${prop}'` : camelCase(prop);
		entries.push(`${key}: '${value.replace(/'/g, "\\'")}'`);
	}
	return entries.join(', ');
}

/** Hyphenated -> camelCase (stroke-width -> strokeWidth). */
function camelCase(name: string): string {
	return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Escape a jsx attribute value, which is double-quoted. */
function escapeAttr(value: string): string {
	return value.replace(/"/g, '&quot;');
}

/** Escape jsx text so braces are not read as expressions. */
function escapeJsxText(text: string): string {
	return text.replace(/[{}]/g, (c) => `{'${c}'}`);
}
