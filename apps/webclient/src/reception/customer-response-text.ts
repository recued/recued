/** Show a compact excerpt while keeping the full canonical reply available. */
export const appendCustomerResponseText = (doc: Document, host: HTMLElement, text: string,
  headingText: string, disclosureText: string) => {
  const heading = doc.createElement('h4'); heading.textContent = headingText; host.appendChild(heading);
  const compact = text.replace(/\s+/g, ' ').trim();
  const excerpt = [...compact].slice(0, 200).join('');
  const summary = doc.createElement('p'); summary.setAttribute('data-customer-response-text','excerpt');
  summary.textContent = excerpt + (excerpt.length < compact.length ? '…' : ''); host.appendChild(summary);
  let details: HTMLDetailsElement | undefined;
  if (text !== compact || [...compact].length > 200) {
    details = doc.createElement('details');
    const label = doc.createElement('summary'); label.textContent = disclosureText; details.appendChild(label);
    const reply = doc.createElement('pre'); reply.setAttribute('data-customer-response-text','full');
    reply.textContent = text; details.appendChild(reply); host.appendChild(details);
  }
  return { summary, details };
};
