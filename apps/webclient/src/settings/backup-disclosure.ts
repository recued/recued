/** Native disclosure: polling updates its contents without changing owner intent. */
export const createBackupDisclosure = (doc: Document, name: string, title: string) => {
  const element = doc.createElement('details'); element.setAttribute('data-backup-disclosure', name);
  const summary = doc.createElement('summary'); summary.textContent = title;
  const body = doc.createElement('div'); body.setAttribute('data-backup-disclosure-body', '');
  element.appendChild(summary); element.appendChild(body);
  return { element, summary, body };
};

/** A deliberate review action must reveal its destination before moving focus. */
export const revealBackupControl = (control: HTMLElement): void => {
  for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
    if (ancestor.tagName === 'DETAILS') (ancestor as HTMLDetailsElement).open = true;
  }
};
