/**
 * reconcile/tree.ts: walking a snip's element tree.
 *
 * Its own module because three phases want the same walk and none of them owns it. The
 * paired walk that aligns a live tree against its clone stays in reconcile/match.ts, since
 * it has to know which nodes a handler injected.
 */

/** Every element in a subtree, root first, in document order. */
export function subtreeElements(root: Element): Element[] {
	const out: Element[] = [];
	const walk = (el: Element): void => {
		out.push(el);
		for (const child of Array.from(el.children)) walk(child);
	};
	walk(root);
	return out;
}
