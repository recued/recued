/** D-201 Slice 10AX (10AS findings 10 and 13) — a recipe's door its owner
 *  closed, in one set of words for the webhook's card and for Kitchen, so the
 *  two never say different things about the same door. Kitchen said "the door
 *  behind this webhook is closed" where the card said there was none, and
 *  "refused" alone where the card said "you closed it"; the card said "closed
 *  before its door was made" of a door its owner closed after it was made.
 *
 *  The server says which (`WebhookIngressRecipeView` and
 *  `LocalRecipeWebhookDoorStatus`, the same three fields): `no_door_yet`, closed
 *  before any door was made; `no_door`, its rows carry no door now; neither, the
 *  door is there and closed. */
export interface OwnerClosedDoorFacts {
  readonly no_door?: true;
  readonly no_door_yet?: true;
}

/** What the owner did and whether a door stands, as a clause with no closing
 *  stop: each surface finishes it with what that means there. */
export const ownerClosedDoorClause = (facts: OwnerClosedDoorFacts): string =>
  facts.no_door_yet === true
    ? 'You closed it before its door was made, so there is no door behind it'
    : facts.no_door === true
      ? 'You closed its door, and there is no door behind it now'
      : 'You closed its door';
