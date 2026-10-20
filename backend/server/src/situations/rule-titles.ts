/** D-325 — a rule named with what it is about. An occasion's default rule takes the occasion's
 * own title (`saveOccasion`), so joining the two named it twice: "Ana · birthday: Ana ·
 * birthday". A rule titled as its subject is named by the subject alone. */
const ownTitle = (rule: { title: string } | undefined, subject: string): string | null =>
  rule && rule.title.trim() && rule.title.trim() !== subject.trim() ? rule.title : null;

/** A task, a reminder or a published rule: "Buy flowers · Ana birthday". */
export const ruleStatement = (rule: { title: string } | undefined, subject: string): string => {
  const own = ownTitle(rule, subject); return own ? `${own} · ${subject}` : subject;
};

/** A notice as Yours lists it: "Ana birthday: Buy flowers". */
export const ruleNotice = (subject: string, rule: { title: string } | undefined): string => {
  const own = ownTitle(rule, subject); return own ? `${subject}: ${own}` : subject;
};
