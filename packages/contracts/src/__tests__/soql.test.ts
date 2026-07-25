import { describe, it, expect } from 'vitest';
import { escapeSoqlStringLiteral, soqlLikeOperand, soqlQuotedLiteral } from '../soql.js';

// The runtime half of the B1 ref-escaping seam. These primitives neutralize an
// attacker-influenced runtime value before it splices into a SOQL `query.q` string,
// so a `{{ref}}` filter value can never break out of its quoted literal.

describe('escapeSoqlStringLiteral', () => {
  it('passes a clean value through unchanged', () => {
    expect(escapeSoqlStringLiteral('Prospecting')).toBe('Prospecting');
  });

  it("escapes single quotes", () => {
    expect(escapeSoqlStringLiteral("O'Brien")).toBe("O\\'Brien");
  });

  it('escapes backslashes before quotes (order matters)', () => {
    // A raw `\'` (backslash, quote) → `\\` (escaped backslash) + `\'` (escaped quote).
    expect(escapeSoqlStringLiteral("\\'")).toBe("\\\\\\'");
  });

  it('neutralizes a SOQL injection attempt — the value stays inside the literal', () => {
    const attack = "x' OR Name != '";
    // Every quote is backslash-escaped, so wrapped in '…' it is one inert literal.
    expect(escapeSoqlStringLiteral(attack)).toBe("x\\' OR Name != \\'");
  });
});

describe('soqlQuotedLiteral', () => {
  it('wraps + escapes a string value', () => {
    expect(soqlQuotedLiteral('Prospecting')).toBe("'Prospecting'");
    expect(soqlQuotedLiteral("O'Brien")).toBe("'O\\'Brien'");
  });

  it('coerces a non-string value to its string form, quoted', () => {
    expect(soqlQuotedLiteral(30000)).toBe("'30000'");
    expect(soqlQuotedLiteral(true)).toBe("'true'");
  });

  it('renders null/undefined as the empty string literal (never a bare empty splice)', () => {
    expect(soqlQuotedLiteral(null)).toBe("''");
    expect(soqlQuotedLiteral(undefined)).toBe("''");
  });

  it('keeps an injection attempt inside the quoted literal', () => {
    expect(soqlQuotedLiteral("x' OR Id != null OR '")).toBe("'x\\' OR Id != null OR \\''");
  });
});

describe('soqlLikeOperand', () => {
  it('wraps + escapes a value in %…%', () => {
    expect(soqlLikeOperand('acme')).toBe("'%acme%'");
    expect(soqlLikeOperand("O'Brien")).toBe("'%O\\'Brien%'");
  });

  it('renders null/undefined as an empty %…% operand', () => {
    expect(soqlLikeOperand(null)).toBe("'%%'");
  });

  it('keeps an injection attempt inside the LIKE operand', () => {
    expect(soqlLikeOperand("a%' OR Name LIKE '%b")).toBe("'%a%\\' OR Name LIKE \\'%b%'");
  });
});
