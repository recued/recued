type BackupControl = HTMLInputElement | HTMLSelectElement;
let nextValidationId = 0;

export const isBackupWholeNumber = (value: string, min: number, max: number): boolean =>
  value.trim() !== '' && Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max;

export const isBackupUtcTime = (value: string): boolean => {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60;
};

/** Stable inline errors; only an explicit failed Save moves keyboard focus. */
export const createBackupFormValidation = (document: Document, prefix: string) => {
  const id = `${prefix}-validation-${++nextValidationId}`;
  const fields: Array<{ control: BackupControl; error: HTMLParagraphElement; issue(): string | undefined }> = [];
  let attempted = false, disposed = false;
  const render = (field: typeof fields[number], message: string | undefined): void => {
    const errorId = field.error.id;
    const descriptions = (field.control.getAttribute('aria-describedby') ?? '').split(/\s+/)
      .filter(value => value !== '' && value !== errorId);
    field.error.textContent = message ?? ''; field.error.hidden = message === undefined;
    if (message !== undefined) {
      field.control.setAttribute('aria-invalid', 'true'); descriptions.push(errorId);
    } else field.control.removeAttribute('aria-invalid');
    if (descriptions.length) field.control.setAttribute('aria-describedby', descriptions.join(' '));
    else field.control.removeAttribute('aria-describedby');
  };
  const update = (): BackupControl | undefined => {
    let first: BackupControl | undefined;
    for (const field of fields) {
      const message = field.issue(); render(field, message);
      if (message !== undefined) first ??= field.control;
    }
    return first;
  };
  return {
    field(control: BackupControl, host: HTMLElement, name: string, issue: () => string | undefined): void {
      const error = document.createElement('p'); error.id = `${id}-${name}`; error.hidden = true;
      error.className = 'rx-msg rx-msg-error';
      error.setAttribute(`data-${prefix}-${name}-error`, ''); host.appendChild(error);
      fields.push({ control, error, issue });
    },
    validate(): boolean {
      if (disposed) return false;
      attempted = true; const first = update(); first?.focus(); return first === undefined;
    },
    refresh(): void { if (!disposed && attempted) update(); },
    reset(): void {
      if (disposed) return;
      attempted = false; for (const field of fields) render(field, undefined);
    },
    dispose(): void { disposed = true; },
  };
};
