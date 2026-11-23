import { expect, it } from 'vitest';
import { createTaskReaderContinuity } from '../note-reader-continuity.js';

/** Model a browser clamping scrollTop while a secondary read temporarily
 * shortens the document. These bounds are state inputs, not CSS dimensions. */
const setup = () => {
  let top = 0, maximum = 1000;
  const document = { activeElement: null as null | HTMLElement };
  const controls = ['first', 'second'].map(key => ({
    tagName: 'BUTTON', getAttribute: (attribute: string) => attribute === 'data-task-focus' ? key : null,
    focus() { document.activeElement = this as unknown as HTMLElement; },
  }));
  const content = { get scrollTop() { return top; }, set scrollTop(value: number) { top = Math.min(maximum, Math.max(0, value)); },
    getBoundingClientRect: () => ({ top: 0 }) };
  const reader = {
    getAttribute: (key: string) => key === 'data-task-id' ? 'one' : 'plain',
    querySelector: (selector: string) => selector === '.work-entity-task-content' ? content : null,
    querySelectorAll: (selector: string) => selector === '[data-task-focus]' ? controls : [],
    contains: (element: unknown) => controls.includes(element as typeof controls[number]),
  };
  const root = { ownerDocument: document, querySelector: () => reader } as unknown as HTMLElement;
  const continuity = createTaskReaderContinuity(); continuity.open('one');
  return { continuity, root, content, controls, document,
    resize(next: number) { maximum = next; top = Math.min(top, maximum); } };
};

it('retains saved coordinates through temporary clamps while continuing to capture focus', () => {
  const f = setup(); f.continuity.restore(f.root); f.content.scrollTop = 800; f.continuity.capture(f.root);
  f.resize(300); f.continuity.restore(f.root, { pending: true });
  f.document.activeElement = f.controls[1] as unknown as HTMLElement; f.continuity.capture(f.root);
  expect(f.continuity.snapshot().positions.plain!.top).toBe(800);
  f.resize(1000); f.continuity.restore(f.root, { pending: true });
  f.resize(250); f.continuity.capture(f.root);
  f.resize(1000); f.continuity.restore(f.root);
  expect(f.content.scrollTop).toBe(800); expect(f.document.activeElement).toBe(f.controls[1]);
});

it('lets user interaction replace a pending restored position', () => {
  const f = setup(); f.continuity.restore(f.root); f.content.scrollTop = 800; f.continuity.capture(f.root);
  f.resize(300); f.continuity.restore(f.root, { pending: true }); f.continuity.interact(f.root);
  f.content.scrollTop = 150; f.continuity.capture(f.root);
  f.resize(100); f.continuity.restore(f.root, { pending: true }); f.continuity.capture(f.root);
  f.resize(1000); f.continuity.restore(f.root);
  expect(f.content.scrollTop).toBe(150);
});

it('allows a newly opened reader to reveal a linked passage while initial data is pending', () => {
  const f = setup(); f.continuity.restore(f.root, { pending: true });
  f.content.scrollTop = 500; f.continuity.capture(f.root);
  f.continuity.restore(f.root, { pending: true });
  f.content.scrollTop = 600; f.continuity.capture(f.root); f.continuity.restore(f.root);
  expect(f.content.scrollTop).toBe(600);
});
