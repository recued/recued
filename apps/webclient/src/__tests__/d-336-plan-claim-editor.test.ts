/** D-336 slice E — the relationship on a held save's approval card: read from the call as
 *  the owner's form holds it, and sent back only when the owner changed it. */
import { describe, expect, it } from 'vitest';

import {
  PLAN_CLAIM_NOTE,
  PLAN_SUMMARY_EMPTY,
  PLAN_SUMMARY_NOTE,
  planClaimDraft,
  planClaimEdit,
  planClaimOf,
  planClaimToSave,
  planRelationshipChanged,
  renderPlanClaimEditor,
} from '../chat/plan-claim-editor.js';

describe("the card reads a held save's relationship as the owner's form holds it", () => {
  it('words, the owner, a contact or a thing, each linked end by the name recorded for it', () => {
    expect(planClaimOf({ summary: 'x', claim: { subject: 'Mia', relation: ' daughter of ', object: 'OWNER' } }))
      .toEqual({ subject: { text: 'Mia' }, relation: 'daughter of', object: { owner: true } });
    expect(planClaimOf(
      { claim: { subject: { contact: 'dana@example.test' }, relation: 'owns', object: { asset: 'a-1' } } },
      { claim: { 'dana@example.test': 'Dana Whitfield', 'a-1': 'Blue bicycle' } },
    )).toEqual({ subject: { contact_id: 'dana@example.test', name: 'Dana Whitfield' }, relation: 'owns', object: { asset_id: 'a-1', name: 'Blue bicycle' } });
    // No names recorded (a lookup that failed): the id, and "a thing you own".
    expect(planClaimOf({ claim: { subject: { contact: 'ct-1' }, relation: 'owns', object: { asset: 'a-1' } } }))
      .toEqual({ subject: { contact_id: 'ct-1', name: 'ct-1' }, relation: 'owns', object: { asset_id: 'a-1', name: 'a thing you own' } });
  });

  it('a relationship already changed on a card is read as it was saved, and anything else as none', () => {
    const owners = { subject: { text: 'Lena' }, relation: "mother of my cousin's boyfriend", object: { text: 'cousin Sara' } };
    expect(planClaimOf({ claim: owners })).toEqual(owners);
    expect(planClaimOf({ summary: 'x' })).toBeUndefined();
    expect(planClaimOf({ claim: { subject: 'Mia', relation: '', object: 'Dana' } })).toBeUndefined();
    expect(planClaimOf(null)).toBeUndefined();
  });
});

describe('what saying yes sends', () => {
  const CALL = { summary: "Mia is Dana's daughter", claim: { subject: 'Mia', relation: 'daughter of', object: 'Dana' } };

  it('nothing when the relationship is as proposed, the owner\'s relationship when it changed, null when removed', () => {
    const draft = planClaimDraft(CALL);
    expect(planClaimEdit(draft)).toBeUndefined();
    // Spaces the owner left around a word are no change.
    expect(planClaimEdit({ ...draft, claim: { ...draft.claim!, relation: '  daughter   of ' } })).toBeUndefined();
    expect(planClaimEdit({ ...draft, claim: { ...draft.claim!, relation: 'stepdaughter of' } }))
      .toEqual({ claim: { subject: { text: 'Mia' }, relation: 'stepdaughter of', object: { text: 'Dana' } } });
    const { claim: _claim, ...removed } = draft;
    expect(planClaimEdit(removed)).toEqual({ claim: null });
    // A save with none, given one on the card.
    const none = planClaimDraft({ summary: 'x' });
    expect(planClaimEdit(none)).toBeUndefined();
    expect(planClaimEdit({ ...none, claim: { subject: { text: 'Dana' }, relation: 'owns', object: { text: 'a blue bicycle' } } }))
      .toEqual({ claim: { subject: { text: 'Dana' }, relation: 'owns', object: { text: 'a blue bicycle' } } });
  });

  /** Audit 2026-10-31 — recall returns the summary, so a relationship corrected beside the
   *  agent's words was recalled as the agent wrote it. */
  it('the summary where the server takes a change to it: sent when it differs, refused when cleared', () => {
    expect(planClaimDraft(CALL).summary).toBeUndefined();
    expect(planClaimDraft(CALL, undefined, ['claim']).summary).toBeUndefined();
    const draft = planClaimDraft(CALL, undefined, ['claim', 'summary']);
    expect(draft).toMatchObject({ summary: CALL.summary, proposedSummary: CALL.summary });
    expect(planClaimEdit({ ...draft, summary: `  ${CALL.summary} ` })).toBeUndefined();
    expect(planClaimEdit({ ...draft, summary: " Mia is Dana's sister " })).toEqual({ summary: "Mia is Dana's sister" });
    expect(planClaimEdit({ ...draft, summary: ' ' })).toEqual({ error: PLAN_SUMMARY_EMPTY });
    const sister = { ...draft.claim!, relation: 'sister of' };
    expect(planClaimEdit({ ...draft, claim: sister, summary: "Mia is Dana's sister" })).toEqual({
      claim: { subject: { text: 'Mia' }, relation: 'sister of', object: { text: 'Dana' } }, summary: "Mia is Dana's sister",
    });
    // The relationship alone decides whether what the save meets still holds.
    expect(planRelationshipChanged({ ...draft, summary: 'Something else' })).toBe(false);
    expect(planRelationshipChanged({ ...draft, claim: sister })).toBe(true);
    expect(planRelationshipChanged({ ...draft, claim: { ...sister, relation: '' } })).toBe(true);
  });

  it('a relationship half written is not sent; one whose three parts are blank is none', () => {
    expect(planClaimToSave({ subject: { text: 'Dana' }, relation: '', object: { text: '' } }))
      .toEqual({ error: 'A relationship needs a first part, a relation and a second part. Fill in all three, or remove it.' });
    expect(planClaimToSave({ subject: { text: ' ' }, relation: ' ', object: { text: '' } })).toEqual({ claim: null });
    expect(planClaimToSave(undefined)).toEqual({ claim: null });
  });
});

describe('the card draws the relationship in the owner\'s memory form', () => {
  it('its own field ids, read-only while it is being approved, and a refusal beside it', () => {
    const draft = { ...planClaimDraft({ claim: { subject: 'Mia', relation: 'daughter of', object: 'Dana' } }), error: 'Refused <here>' };
    const html = renderPlanClaimEditor(draft, 'chat-plan-claim-p1', true);
    expect(html).toContain('id="chat-plan-claim-p1-subject"');
    expect(html).toContain('list="chat-plan-claim-p1-relations"');
    expect(html).not.toContain('id="memory-claim-subject"');
    expect(html.match(/ readonly/g)).toHaveLength(3);
    expect(html).toContain('<p class="chat-plan-claim-error" role="alert">Refused &lt;here&gt;</p>');
    expect(renderPlanClaimEditor(planClaimDraft({ summary: 'x' }), 'p', false)).toContain('Add a relationship');
  });

  it('the summary field first where it may change, escaped, read-only while it is being approved', () => {
    const call = { summary: 'Mia <is> "Dana\'s" daughter', claim: { subject: 'Mia', relation: 'daughter of', object: 'Dana' } };
    const html = renderPlanClaimEditor(planClaimDraft(call, undefined, ['claim', 'summary']), 'chat-plan-claim-p1', true);
    expect(html).toContain('<label class="memory-field-label" for="chat-plan-claim-p1-summary">Summary</label>');
    expect(html).toContain('>Mia &lt;is&gt; &quot;Dana&#39;s&quot; daughter</textarea>');
    expect(html.match(/ readonly/g)).toHaveLength(4);
    expect(html).toContain(PLAN_SUMMARY_NOTE);
    expect(html.indexOf('-summary"')).toBeLessThan(html.indexOf('-subject"'));
    const older = renderPlanClaimEditor(planClaimDraft(call, undefined, ['claim']), 'p', false);
    expect(older).not.toContain('-summary"');
    expect(older).toContain(PLAN_CLAIM_NOTE);
  });
});
