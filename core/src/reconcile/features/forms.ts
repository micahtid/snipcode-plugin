/**
 * features/forms.ts: control chrome and the live state cloneNode drops.
 *
 * Bakes non-default appearance and accent-color: appearance: none is how a custom-styled
 * control replaces the native widget, and losing it snaps the control back to the os one.
 *
 * It also mirrors value, checked, and selected onto the clone as attributes. cloneNode copies
 * a control's attributes but not its current state, so a filled input or ticked checkbox
 * would render empty.
 */
import type { Captured } from '../../types';
import { pairedSubtrees } from '../match';

const FORM_CONTROL = 'input, select, textarea, button, meter, progress, option';

/**
 * Bakes form-control styling and mirrors live control state onto the clone.
 *
 * @param captured - bakedStyles + clone mutated in place
 */
export function apply(captured: Captured): Captured {
	for (const [original, clone] of pairedSubtrees(captured.root, captured.clone)) {
		let isControl = false;
		try {
			isControl = original.matches(FORM_CONTROL);
		} catch {
			isControl = false;
		}
		if (!isControl) continue;

		const computed = getComputedStyle(original);
		const baked = captured.bakedStyles.get(clone) ?? new Map<string, string>();
		bake(clone, baked, 'appearance', computed.getPropertyValue('appearance'), (v) => v === 'auto' || v === '');
		bake(clone, baked, '-webkit-appearance', computed.getPropertyValue('-webkit-appearance'), (v) => v === 'auto' || v === '');
		bake(clone, baked, 'accent-color', computed.getPropertyValue('accent-color'), (v) => v === 'auto' || v === '');
		if (baked.size > 0) captured.bakedStyles.set(clone, baked);

		mirrorState(original, clone);
	}
	return captured;
}

/** Mirror a control's live value/checked/selected onto the clone as attributes. */
function mirrorState(original: Element, clone: Element): void {
	if (original instanceof HTMLInputElement && clone instanceof HTMLInputElement) {
		if (original.type === 'checkbox' || original.type === 'radio') {
			if (original.checked) clone.setAttribute('checked', '');
			else clone.removeAttribute('checked');
		} else if (original.value) {
			clone.setAttribute('value', original.value);
		}
	} else if (original instanceof HTMLTextAreaElement && clone instanceof HTMLTextAreaElement) {
		clone.textContent = original.value;
	} else if (original instanceof HTMLOptionElement && clone instanceof HTMLOptionElement) {
		if (original.selected) clone.setAttribute('selected', '');
		else clone.removeAttribute('selected');
	} else if (
		(original instanceof HTMLMeterElement || original instanceof HTMLProgressElement) &&
		(clone instanceof HTMLMeterElement || clone instanceof HTMLProgressElement)
	) {
		clone.setAttribute('value', String(original.value));
	}
}

/** Bake a value onto the clone + baked map when a predicate says it is non-default. */
function bake(clone: Element, baked: Map<string, string>, prop: string, value: string, isDefault: (v: string) => boolean): void {
	if (baked.has(prop) || !value || isDefault(value)) return;
	baked.set(prop, value);
	try {
		(clone as HTMLElement).style.setProperty(prop, value);
	} catch {
		// Invalid for this element, so skip it.
	}
}
