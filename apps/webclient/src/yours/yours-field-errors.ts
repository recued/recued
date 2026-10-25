type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Keep a failed edit at its field, including fields inside a closed disclosure. */
export function yoursFieldError(control: Control, message: string): never {
  const doc = control.ownerDocument;
  let details = control.closest('details');
  while (details) { details.open = true; details = details.parentElement?.closest('details') ?? null; }
  const previous = control.getAttribute('aria-errormessage');
  if (previous) doc.getElementById(previous)?.remove();
  const error = doc.createElement('small'); error.className = 'yours-field-error';
  error.id = `yours-field-error-${globalThis.crypto.randomUUID()}`; error.textContent = message;
  control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-errormessage', error.id);
  control.insertAdjacentElement('afterend', error); control.focus();
  control.scrollIntoView?.({ block: 'nearest' });
  throw new Error(message);
}

export const clearYoursFieldErrors = (form: HTMLFormElement) => {
  for (const control of form.querySelectorAll<Control>('[aria-errormessage]')) {
    control.removeAttribute('aria-invalid'); control.removeAttribute('aria-errormessage');
  }
  form.querySelectorAll('.yours-field-error').forEach(error => error.remove());
};
