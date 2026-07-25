/** HTML escape — every user-supplied string that ends up inside a
 *  template literal must flow through this function. Template
 *  literals do NOT escape by default; forgetting this turns a
 *  malicious recipe name into script execution.
 */

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return c;
    }
  });

/** Tagged alias — makes `escapeHtml` act as a one-character marker
 *  at interpolation sites without per-call imports. */
export const e = escapeHtml;
