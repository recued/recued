/** D-327 follow-on — what each of Recued's own switches on a contract does, in the
 *  owner's words.
 *
 *  ⛔ ONE TEXT, TWO READERS. The Contracts page shows it beside each switch, and the
 *  public docs page `recued-docs/content/reference/grant-switches.md` is generated
 *  from it, so the page and the docs cannot say different things. The generator is
 *  `scripts/grant-switch-docs.mts`; `scripts/grant-switch-docs.test.ts` fails when
 *  the committed page drifts from this file.
 *
 *  ⛔ WRITTEN, NOT DERIVED. The kernel manifests carry a `name` and a `description`,
 *  but those are written for the AI that calls the op ("Tombstone (default) or
 *  hard-delete a note", "Run a SQLite FTS5 query against `data.email.{slug}.*`"). An
 *  owner deciding whether an AI app may do something needs the plain sentence.
 *
 *  ⚠ COMPLETE BY TEST. Every `KERNEL_OP_REGISTRY` op, every Tier-1 tool and every
 *  collection a contract can switch has an entry (`grant-switch-guide.test.ts`), so
 *  a new op that ships without one goes red there instead of reaching an owner as a
 *  bare id.
 *
 *  ⚠ `needs` IS A STATEMENT ABOUT THE SERVER, AND THE SERVER PINS IT. Each AI tool
 *  checks other switches before it does anything (`chat-tool-handlers.ts`), and the
 *  page tells the owner to switch those on. A handler that starts checking a
 *  different op must change the list here: `d-327-tool-needs.test.ts` compares it
 *  with the handlers' own constants. */

import type { ApprovalValueLabels } from './ask-detail-label.js';
import type { Tier1ToolName } from './chat.js';
import { COLLECTION_GRANT_PREFIX, PRIMITIVE_GRANT_PREFIX } from './grant-entry.js';
import type { WorkEntityKind } from './work-entities.js';

/** What a switch lets happen, for a person deciding whether to allow it. */
export interface GrantSwitchText {
  /** A few words, shown beside the switch: "Create a task". */
  readonly title: string;
  /** One or two short sentences, for the hover text and the public docs. */
  readonly summary: string;
}

/** Another switch an AI tool checks before it does anything. */
export interface Tier1ToolNeed {
  /** The grant entry key of that switch: a kernel op id or `data.<collection>`. */
  readonly entry: string;
  /** When it is needed, when not always: "to add tasks". Absent ⇒ every call. */
  readonly when?: string;
  /** Set when the need applies to one kind of item only, and the switch's own title
   *  already names that kind ("Your tasks", "Create a task"). The page then shows
   *  the title alone; the docs, which show ids, keep `when`. */
  readonly kind?: WorkEntityKind;
}

/** An AI tool's text, plus what else it needs. */
export interface Tier1ToolGuide extends GrantSwitchText {
  /** The other switches this tool checks. Empty when it checks none. */
  readonly needs: readonly Tier1ToolNeed[];
  /** Anything else an owner must know, such as a limit no switch lifts. */
  readonly note?: string;
}

const t = (title: string, summary: string): GrantSwitchText => ({ title, summary });

// ────────────────────────────────────────────────────────────────
// Recued's own operations (`KERNEL_OP_REGISTRY`), by op id
// ────────────────────────────────────────────────────────────────

/** Every Recued operation, by op id. Recipes run these as steps, and several AI
 *  tools check one before they act (`TIER1_TOOL_GUIDE[...].needs`). */
export const KERNEL_OP_GUIDE: Readonly<Record<string, GrantSwitchText>> = {
  // ── AI models
  'core.ai.classify': t('Sort into a category', 'Asks your AI model which category, from a list the recipe gives, fits some text best.'),
  'core.ai.compare': t('Compare two things', 'Asks your AI model how two pieces of data differ and where they match.'),
  'core.ai.embed': t('Turn text into numbers for search', 'Asks your AI model for numbers that stand for what some text means. Search by meaning uses them.'),
  'core.ai.extract': t('Pull out fields', 'Asks your AI model to pull named fields, like a date or an amount, out of free text.'),
  'core.ai.generate': t('Draft text', 'Asks your AI model to write a draft, like an email or an agenda, from data the recipe gives.'),
  'core.ai.prompt': t('Ask your AI model anything', 'Sends the recipe’s own question to your AI model and returns the answer. It cannot search the web.'),
  'core.ai.rewrite': t('Rewrite text', 'Asks your AI model to rewrite text in another style.'),
  'core.ai.score': t('Score against a list', 'Asks your AI model to score data against a list of points.'),
  'core.ai.sentiment': t('Read the mood of text', 'Asks your AI model whether text sounds positive, neutral or negative.'),
  'core.ai.summarize': t('Summarize', 'Asks your AI model for a short summary and the key points of a long text.'),
  'core.ai.translate': t('Translate', 'Asks your AI model to put text into another language.'),

  // ── Mail
  'core.mail.get': t('Read one email', 'Reads one email from the copy of your mail on your server.'),
  'core.mail.body-read': t('Read the full text of an email', 'Reads the whole text of one email.'),
  'core.mail.thread-read': t('Read an email thread', 'Puts every email in one thread together, oldest first.'),
  'core.mail.fact.get': t('Read one mail fact', 'Reads one thing Recued found in your mail, like a parcel or a bill, and the facts behind it.'),
  'core.mail.fact.list': t('List mail facts', 'Lists the parcels, orders and bills Recued found in your mail, newest first.'),
  'core.mail.send': t('Send an email', 'Sends an email from one of your mail accounts.'),
  'core.mail.notify-booking-visitor': t('Email the visitor of a booking', 'Tells the person behind a booking that it changed. Recued finds their address itself, so the recipe never sees it.'),
  'core.mail.sent.reconcile': t('Check that an email really went', 'Asks your mail provider whether an email Recued sent really left, and records the answer.'),
  'core.mail.mark': t('Mark an email read or unread', 'Marks one email read or unread, in your mail account and on your server.'),
  'core.mail.flag': t('Flag an email', 'Stars or flags one email, or takes the flag off.'),
  'core.mail.move': t('Move an email to a folder', 'Files one email into another folder or label.'),
  'core.mail.delete': t('Delete an email', 'Deletes one email from your mail account and from your server.'),
  'core.mail.email.get': t('Read one stored email', 'Reads one email from a mailbox stored on your server, by its id.'),
  'core.mail.email.list': t('List stored emails', 'Lists emails from a mailbox, picked by sender, folder, date and more.'),
  'core.mail.email.search': t('Search stored emails', 'Searches the words in the emails stored on your server.'),
  'core.mail.draft.create': t('Save a new draft', 'Saves a new email draft on your server. Nothing is sent.'),
  'core.mail.draft.read': t('Read a saved draft', 'Reads an email draft saved on your server.'),
  'core.mail.draft.update': t('Change a saved draft', 'Changes an email draft saved on your server.'),
  'core.mail.draft.delete': t('Delete a saved draft', 'Deletes an email draft saved on your server.'),
  'core.mail.draft.save-to-mailbox': t('Put a draft in your mailbox', 'Copies a saved draft into the Drafts folder of your mail account. You can finish it in your mail app.'),

  // ── Contacts
  'core.contact.resolve': t('Find a contact', 'Finds a contact from an email, a phone number, a nickname or an account on another site.'),
  'core.contact.business-context': t('See the business links of a contact', 'Counts the deals, tasks, meetings, bookings and projects linked to one contact. It uses no AI.'),
  'core.contact.upsert': t('Add or update a contact', 'Adds a contact, or updates the one with the same email.'),
  'core.contact.engagements.read': t('See your history with a contact', 'Lets an AI read the emails, meetings and other contact you have had with one person.'),

  // ── Notifications and reminders
  'core.notification.send': t('Send you a notification', 'Sends a message to you on the channels you set up, like Slack, Telegram or email. It cannot reach anyone else.'),
  'core.preapproval.request': t('Ask you to approve a future run', 'Puts a planned recipe run or a saved draft in front of you to approve. It cannot approve anything itself.'),
  'core.reminder.create': t('Set a reminder', 'Sets a reminder for you. Recued sends it once, at the time chosen.'),
  'core.reminder.list': t('List your reminders', 'Lists the reminders still to come, soonest first.'),
  'core.reminder.update': t('Change a reminder', 'Changes the words or the time of a reminder still to come.'),
  'core.reminder.cancel': t('Cancel a reminder', 'Cancels a reminder still to come, so it never goes off.'),
  'core.notification.recipe-callback': t('Nudge a connected AI app', 'Tells an AI app that an answer it asked for may have changed. The app must ask again to see anything.'),

  // ── Tasks, notes and more
  'core.work-entity.note.create': t('Create a note', 'Adds a note. It goes on your server unless the recipe picks a connected app.'),
  'core.work-entity.note.update': t('Change a note', 'Changes the fields of a note.'),
  'core.work-entity.note.delete': t('Delete a note', 'Deletes a note.'),
  'core.work-entity.task.create': t('Create a task', 'Adds a task. It goes on your server unless the recipe picks a connected app.'),
  'core.work-entity.task.update': t('Change a task', 'Changes the fields of a task.'),
  'core.work-entity.task.delete': t('Delete a task', 'Deletes a task.'),
  'core.work-entity.task.mark-done': t('Mark a task done', 'Ticks a task off as done.'),
  'core.work-entity.task.mark-reminder-fired': t('Mark a reminder task as sent', 'Marks a reminder kept as a task as sent, so it is no longer due.'),
  'core.work-entity.commitment.create': t('Create a commitment', 'Adds a commitment: a promise you made, or one made to you.'),
  'core.work-entity.commitment.propose': t('Suggest a commitment', 'Suggests a commitment for you to check. It is only added once you say yes.'),
  'core.work-entity.commitment.update': t('Change a commitment', 'Changes the details of a commitment.'),
  'core.work-entity.commitment.cancel': t('Cancel a commitment', 'Marks a commitment as cancelled.'),
  'core.work-entity.commitment.fulfill': t('Mark a commitment kept', 'Marks a commitment as kept.'),
  'core.work-entity.project.create': t('Create a project', 'Adds a project. It goes on your server unless the recipe picks a connected app.'),
  'core.work-entity.project.update': t('Change a project', 'Changes the fields of a project.'),
  'core.work-entity.project.archive': t('Archive a project', 'Moves a project to the archive.'),
  'core.work-entity.booking.create': t('Create a booking', 'Adds a booking: who the customer is, when it is, and what it is worth.'),
  'core.work-entity.booking.update': t('Change a booking', 'Changes a booking, which is also how a booking is cancelled or finished.'),
  'core.work-entity.booking.delete': t('Delete a booking', 'Deletes a booking.'),
  'core.work-entity.asset.create': t('Add a thing you own', 'Adds a thing you keep track of, like a car or a device, and where its facts came from.'),
  'core.work-entity.asset.update': t('Change a thing you own', 'Changes the facts about a thing you keep track of.'),
  'core.work-entity.asset.delete': t('Delete a thing you own', 'Deletes a thing you keep track of, with its readings.'),
  'core.work-entity.asset.observe': t('Record a reading', 'Lets a recipe record a reading, like a meter value, for a thing you own. It records only what you allowed.'),
  'core.work-entity.list': t('List tasks, notes and more', 'Lets a recipe list the items of one kind: tasks, notes, commitments, projects, bookings or things you own.'),
  'core.work-entity.get': t('Read one task, note or more', 'Lets a recipe read one item, like a task or a note, by its id.'),
  'core.work-entity.read': t('Read tasks, notes and more', 'Lets an AI read and search your tasks, notes, commitments, projects, bookings and things you own. Each kind also needs its own data switch.'),
  'core.work-entity.approval-workflow.continue': t('Carry on a job a customer accepted', 'After you approve, finishes a task, keeps a commitment or starts a saved recipe that a customer accepted.'),
  'core.work-entity.customer-invoice.credit': t('Credit a customer invoice', 'After you check it, records a credit on an invoice and lowers what is still owed.'),
  'core.work-entity.customer-invoice.credit.correct': t('Correct an invoice credit', 'After you check it, undoes a credit on an invoice and can add a new one in its place.'),
  'core.work-entity.customer-refund.apply': t('Record a customer refund', 'After you check it, records a refund to a customer.'),
  'core.work-entity.customer-refund.correct': t('Correct a customer refund', 'After you check it, undoes a wrong refund record and can add a new one in its place.'),
  'core.work-entity.customer-account-payment.apply': t('Record a customer payment', 'After you check it, records a payment from a customer across the invoices it pays.'),
  'core.work-entity.customer-account-payment.correct': t('Correct a customer payment', 'After you check it, corrects or cancels how a payment was split across invoices.'),
  'core.work-entity.customer-payment.correct': t('Correct an invoice payment', 'After you check it, corrects or cancels one payment and fixes what the invoice still owes.'),
  'core.work-entity.quote-completion.review': t('Close or reopen a finished job', 'After you approve, closes the task for work the customer accepted, or reopens it for changes.'),
  'core.work-entity.quote-signoff.release': t('Release an accepted quote', 'After you approve, turns an accepted quote into a task and an invoice.'),

  // ── Situations
  'core.situation.read': t('Read what is going on', 'Reads a short, ranked picture of what is going on around a time. Each kind of item also needs its own switches.'),
  'core.situation.prefetch': t('Look ahead before each chat turn', 'Lets Recued add a short picture of what is going on to your chat before the AI answers.'),

  // ── Memory, notes on records, links and history
  'core.memory.annotation.create': t('Add a note to a record', 'Sticks a small labelled fact onto a record, like a contact or an email.'),
  'core.memory.annotation.delete': t('Remove notes from records', 'Removes the labelled facts that this recipe stuck onto records.'),
  'core.memory.annotation.list': t('List notes on records', 'Lists the labelled facts stuck onto records.'),
  'core.memory.annotation.search': t('Search notes on records', 'Searches the words in the labelled facts stuck onto records.'),
  'core.memory.link.create': t('Link two records', 'Records that two things belong together, like an email and the contact who sent it.'),
  'core.memory.link.delete': t('Remove links', 'Removes the links between records that match, whoever made them.'),
  'core.memory.link.list': t('List links', 'Lists the links between records.'),
  'core.memory.timeline.read': t('Read the timeline of a record', 'Lists everything about one person or thing in date order: mail, events, notes and more.'),
  'core.audit.read': t('Read run history', 'Lets an AI read what your recipes did, and when.'),
  'core.memory.write': t('Save to your memory', 'Lets an AI save a fact to your memory, or forget one it saved. You see each one and can undo it.'),
  'core.memory.read': t('Read your memory', 'Lets an AI search the facts and notes saved in your memory.'),
  'core.recall.search': t('Search past conversations', 'Lets your own chat find what was said in earlier conversations. An AI app cannot use it.'),

  // ── Worked-out facts
  'core.data.enrichment.upsert': t('Save a worked-out fact', 'Saves a fact Recued worked out about a record, like a score or a summary.'),
  'core.data.enrichment.list': t('List worked-out facts', 'Lists the facts Recued worked out about records, newest first.'),
  'core.data.enrichment.read': t('Read worked-out facts', 'Lets an AI read the facts Recued worked out about a record.'),
  'core.data.enrichment.vector-search': t('Search facts by meaning', 'Lets an AI find worked-out facts that mean something close to what it asks.'),
  'core.data.enrichment.describe': t('See which facts exist', 'Lets an AI see the kinds of facts Recued works out, and what each one holds.'),

  // ── Calendar
  'core.data.calendar.get': t('Read one calendar event', 'Reads one event from the copy of your calendar on your server.'),
  'core.data.calendar.list': t('List calendar events', 'Lists events from one calendar, or from all of them, in time order.'),
  'core.data.calendar.search': t('Search calendar events', 'Searches the titles, notes and places of your events.'),
  'core.data.calendar.stat': t('Check a calendar event', 'Checks whether an event exists and reads its time and status, without the details.'),
  'core.data.calendar.create': t('Create a calendar event', 'Adds an event to one of your calendars.'),
  'core.data.calendar.update': t('Change a calendar event', 'Changes an event on one of your calendars.'),
  'core.data.calendar.delete': t('Delete a calendar event', 'Deletes an event from one of your calendars.'),
  'core.data.calendar.rsvp': t('Answer an invitation', 'Says yes, no or maybe to a meeting invitation, for you.'),

  // ── Form answers and webhooks
  'core.data.form-response.list': t('List form answers', 'Lists the answers to your forms that you accepted.'),
  'core.data.form-response.get': t('Read one form answer', 'Reads one answer to a form that you accepted.'),
  'core.data.form-response.set-state': t('Move a form answer along', 'Marks a form answer as in review, accepted, declined or a no-show.'),
  'core.webhook.event.get': t('Read a webhook message', 'Lets the recipe a webhook started read the message that started it.'),

  // ── Peers
  'core.peer.ask': t('Ask the owner of another server', 'Puts one question to the owner of another Recued server, then waits for the answer.'),
  'core.peer.receive-ask': t('Take questions from a peer', 'Lets another Recued server put a question to you. You see it and choose the answer.'),
  'core.peer.receive-answer': t('Take answers from a peer', 'Lets the answer to a question you sent come back from that server.'),
  'core.storage.exchange.status': t('Check a question sent to a peer', 'Checks what happened to a question you sent to another server.'),

  // ── Shared store
  'core.storage.shared.write': t('Save a value', 'Saves a value under a name in the shared store, where recipes keep notes between runs.'),
  'core.storage.shared.compare-and-set': t('Save a value only if unchanged', 'Saves a value only if nobody changed it since it was read.'),
  'core.storage.shared.patch': t('Change part of a value', 'Changes some fields of a saved value and leaves the rest.'),
  'core.storage.shared.read': t('Read a value', 'Reads one saved value by its name.'),
  'core.storage.shared.delete': t('Delete a value', 'Deletes one saved value.'),
  'core.storage.shared.delete-prefix': t('Delete values by name', 'Deletes every saved value whose name starts the same way.'),
  'core.storage.shared.list': t('List values', 'Lists the saved values whose names start the same way.'),
  'core.storage.shared.search': t('Search values', 'Searches the words in saved values.'),

  // ── Files
  'core.storage.file.read': t('Read a file', 'Reads what is in one file in a connected folder.'),
  'core.storage.file.write': t('Write a file', 'Saves a file into a connected folder.'),
  'core.storage.file.delete': t('Delete a file', 'Deletes one file from a connected folder.'),
  'core.storage.file.get': t('Read one stored file', 'Reads one file stored on your server, by its id.'),
  'core.storage.file.list': t('List files', 'Lists the files in a connected folder.'),
  'core.storage.file.move': t('Move a file', 'Moves a file to another place.'),
  'core.storage.file.stat': t('Check a file', 'Checks whether a file exists and reads its size and date, without what is in it.'),
  'core.storage.file.persist': t('Keep a file a step made', 'Keeps a file that a recipe step made, so it is not thrown away when the run ends.'),
  'core.storage.file.read-temp': t('Read a file a step made', 'Reads a file that an earlier step in the same run made.'),
  'core.storage.file.put-ref': t('Copy a file into a folder', 'Writes a stored file into a named place in a connected folder.'),
  'core.storage.file.folders': t('List your folders', 'Lists your connected folders, and whether a file can be saved into each one.'),
  'core.storage.file.save-to-folder': t('Save a file into a folder', 'Saves a stored file, like an email attachment, into the folder you named.'),
  'core.storage.file.render-markdown-template': t('Fill in a document template', 'Fills a Markdown template with a few set values, like a name and a date.'),
  'core.storage.file.set-scan-status': t('Record a virus scan result', 'Marks a received file as clean or flagged, after a virus scan.'),
  'core.storage.file.fetch-remote': t('Fetch files from connected apps', 'Lets Recued fetch what is in a file from a connected app, like a cloud drive. It applies to the whole server.'),
  'core.storage.csv.filter': t('Save matching spreadsheet rows', 'Saves the rows of a CSV file that match into a new file.'),
  'core.storage.csv.rows': t('Search a spreadsheet', 'Returns the rows of a CSV file that match, and saves nothing.'),
  'core.storage.csv.stats': t('Sum up a spreadsheet', 'Counts the rows of a CSV file and sums up each column.'),
  'core.storage.csv.columns': t('Read spreadsheet columns', 'Reads the column names of a CSV file.'),
  'core.storage.csv.inspect': t('Inspect a spreadsheet', 'Reads column names, row counts and a small sample from a CSV file. Saves nothing.'),
  'core.storage.csv.transform': t('Create a spreadsheet from other files', 'Filters, joins, compares or sums up CSV files and saves a new file. The source files stay the same.'),
  'core.storage.ics.read': t('Read a calendar file', 'Reads a calendar file, like an emailed invitation, and saves nothing.'),
  'core.storage.data-file-read': t('Read a received file', 'Reads a file your server received, like an email attachment.'),

  // ── Kitchen
  'core.kitchen.draft.import': t('Import source into Kitchen', 'Adds recipe or pack source as a draft for you to review. It does not install or run it.'),
  'core.kitchen.draft.list': t('List Kitchen drafts', 'Lists drafts created through this connection without returning their source.'),
  'core.kitchen.draft.get': t('Read Kitchen draft source', 'Reads source from a draft created through this connection.'),
  'core.kitchen.draft.update': t('Update Kitchen draft source', 'Saves edited source to a draft created through this connection, checking its revision. It does not install or run it.'),
  // ── Schedules
  'core.schedule.prompt': t('Scheduled prompts', 'Lets your own chat create and manage scheduled AI requests.'),
  'core.schedule.recipe': t('Schedule recipes', 'Lets your own chat set a recipe to run later or on a timer. An AI app cannot schedule recipes.'),

  // ── Selling
  'core.seller.offer.ensure': t('Set up a draft offer', 'Sets up a draft of something to sell. It cannot make the offer live.'),
  'core.seller.offer.attach-fulfillment': t('Link an offer to its recipe', 'Links an offer to the recipe that delivers it.'),
  'core.seller.offer.get': t('Read an offer', 'Reads one of your offers.'),
  'core.seller.offer.list': t('List offers', 'Lists your offers.'),
  'core.seller.order.open': t('Open an order', 'Opens an order for one purchase of an offer.'),
  'core.seller.order.get': t('Read an order', 'Reads one order.'),
  'core.seller.order.list': t('List orders', 'Lists your orders.'),
  'core.seller.order.quote': t('Price an order', 'Sets the price of an order that is not paid yet.'),
  'core.seller.order.attach-payment': t('Link a checkout to an order', 'Links the checkout of your payment provider to an order, which then waits for payment.'),
  'core.seller.order.confirm-payment': t('Confirm an order was paid', 'Marks an order as paid. Nothing else can.'),
  'core.seller.order.confirm-renewal-payment': t('Confirm a renewal was paid', 'Marks the order for one renewal as paid, one order for each billing period.'),
  'core.seller.order.confirm-refund': t('Confirm an order was refunded', 'Marks an order as refunded. Nothing else can.'),
  'core.seller.order.attach-artifact': t('Attach what was delivered', 'Attaches the finished work the customer paid for to the order.'),
  'core.seller.order.transition': t('Move an order along', 'Moves an order to its next step, like delivering, complete or cancelled.'),
  'core.seller.order.link-work-entity': t('Link an order to a task', 'Links an order to the task or commitment for the work.'),
  'core.seller.order.link-customer': t('Link an order to a customer', 'Links a paid order to the customer who got access.'),
  'core.seller.tier.get': t('Read a price tier', 'Reads one of your price tiers.'),
  'core.seller.tier.list': t('List price tiers', 'Lists your price tiers.'),
  'core.seller.customer-access.issue': t('Give a customer access', 'Gives a paying customer access, or gives them more time.'),
  'core.seller.customer-access.extend': t('Extend the access of a customer', 'Gives a customer more time.'),
  'core.seller.customer-access.swap-tier': t('Move a customer to another tier', 'Moves a customer to another price tier.'),
  'core.seller.customer-access.close': t('End the access of a customer', 'Ends the access of a customer.'),
  'core.customer.status': t('Let a customer check their access', 'Lets a customer see the state of their own access.'),

  // ── Triggers
  'core.watch.time': t('Run only at set times', 'Lets a recipe run only on chosen days or hours.'),
  'core.watch.time-relative': t('Run before or after a date', 'Starts a recipe when the time comes near a date on a record, like a day before a meeting.'),
  'core.watch.http': t('Watch a web page', 'Starts a recipe when a web page changes.'),

  // ── Browser
  'core.dom.read': t('Read from a web page', 'Reads text from a web page open in your browser, through the Browser Bridge.'),
  'core.dom.write': t('Type into a web page', 'Types into a web page open in your browser, through the Browser Bridge.'),
};

// ────────────────────────────────────────────────────────────────
// The AI tools (Tier-1), and what else each one needs
// ────────────────────────────────────────────────────────────────

const WORK_READ_NEEDS: readonly Tier1ToolNeed[] = [
  { entry: 'core.work-entity.read' },
  { entry: `${COLLECTION_GRANT_PREFIX}task`, when: 'for tasks', kind: 'task' },
  { entry: `${COLLECTION_GRANT_PREFIX}note`, when: 'for notes', kind: 'note' },
  { entry: `${COLLECTION_GRANT_PREFIX}commitment`, when: 'for commitments', kind: 'commitment' },
  { entry: `${COLLECTION_GRANT_PREFIX}project`, when: 'for projects', kind: 'project' },
  { entry: `${COLLECTION_GRANT_PREFIX}booking`, when: 'for bookings', kind: 'booking' },
  { entry: `${COLLECTION_GRANT_PREFIX}asset`, when: 'for things you own', kind: 'asset' },
];

const CRM_LIVE_NOTE = 'To search the CRM itself, the search switch of that CRM must be on too.';

/** The kind of thing a work tool adds or changes, as an approval names it. */
const WORK_KIND_WORDS: Readonly<Partial<Record<WorkEntityKind, string>>> = {
  task: 'a task', note: 'a note', commitment: 'a commitment', project: 'a project', asset: 'a thing you own',
};
/** D-329 — what one call of an AI tool does, in the owner's words: the tool's title, or
 *  for the work tools the kind of thing it adds or changes ("Change a thing you own"). A
 *  held call's ask, its card and the chat's reply name it so. `undefined` for a name that
 *  is no AI tool. */
export const tier1CallTitle = (tool: string, args: unknown): string | undefined => {
  if (!Object.hasOwn(TIER1_TOOL_GUIDE, tool)) return undefined;
  const call = args !== null && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const words = typeof call.kind === 'string' && Object.hasOwn(WORK_KIND_WORDS, call.kind)
    ? WORK_KIND_WORDS[call.kind as WorkEntityKind] : undefined;
  if (words !== undefined && tool === 'work.create') return `Add ${words}`;
  if (words !== undefined && tool === 'work.update') return call.done === true ? 'Tick a task off' : `Change ${words}`;
  return TIER1_TOOL_GUIDE[tool as Tier1ToolName].title;
};

/** What a work tool's call names by its `id`, in the owner's words. */
const WORK_KIND_NOUNS: Readonly<Partial<Record<WorkEntityKind, string>>> = {
  task: 'Task', note: 'Note', commitment: 'Commitment', project: 'Project', asset: 'Thing',
};
/** D-329 — one call of an AI tool's arguments as an approval lists them: the record it
 *  changes named as what it is ("Thing: Family car", not "id: Family car"), and its `kind`
 *  left to the title, which already says it ("Change a thing you own"). The names recorded
 *  for its values (`value_labels`) move with their keys. Display only: the call itself is
 *  what runs, and a key the new name would overwrite keeps its own name. */
export const tier1CallDetails = (
  tool: string,
  args: Readonly<Record<string, unknown>>,
  labels?: ApprovalValueLabels,
): { args: Record<string, unknown>; labels?: ApprovalValueLabels } => {
  // A key's name on the approval, or `null` for a key the title already says.
  const shownAs: Record<string, string | null> = {};
  const noun = typeof args.kind === 'string' && Object.hasOwn(WORK_KIND_NOUNS, args.kind)
    ? WORK_KIND_NOUNS[args.kind as WorkEntityKind] : undefined;
  if (noun !== undefined && (tool === 'work.create' || tool === 'work.update')) {
    Object.assign(shownAs, { kind: null, id: noun, belongs_to: 'Part of' });
  }
  if (tool === 'calendar.update') shownAs.source_id = 'Event';
  // Read off a stored hold, so a malformed value names nothing (`approvalValueLabel`).
  const known = labels !== null && typeof labels === 'object' && !Array.isArray(labels) ? labels : {};
  const shown: Record<string, unknown> = {};
  const named: Record<string, Readonly<Record<string, string>>> = {};
  for (const [key, value] of Object.entries(args)) {
    const renamed = Object.hasOwn(shownAs, key) ? shownAs[key] as string | null : key;
    if (renamed === null) continue;
    const as = renamed !== key && Object.hasOwn(args, renamed) ? key : renamed;
    shown[as] = value;
    if (Object.hasOwn(known, key)) named[as] = known[key]!;
  }
  return { args: shown, ...(Object.keys(named).length > 0 ? { labels: named } : {}) };
};

/** Every AI tool: what it does, and the other switches it checks first. An AI app,
 *  or your own chat, calls these by name. Recipes never do. */
export const TIER1_TOOL_GUIDE: Readonly<Record<Tier1ToolName, Tier1ToolGuide>> = {
  'contact.search': {
    title: 'Search your contacts',
    summary: 'Finds people in your contacts by name, email, phone, company or nickname.',
    needs: [{ entry: `${COLLECTION_GRANT_PREFIX}contact`, when: 'for your own contacts' }],
    note: CRM_LIVE_NOTE,
  },
  'contact.read': {
    title: 'Read the details of a contact',
    summary: 'Reads the title, birthday, address and relationship of one contact.',
    needs: [{ entry: `${COLLECTION_GRANT_PREFIX}contact` }],
  },
  'mail.search': {
    title: 'Search your mail',
    summary: 'Searches your mail by subject, sender, words or date.',
    needs: [{ entry: `${COLLECTION_GRANT_PREFIX}mail` }],
  },
  'mail.read': {
    title: 'Read an email',
    summary: 'Reads one email in full and lists its attachments.',
    needs: [
      { entry: `${COLLECTION_GRANT_PREFIX}mail` },
      { entry: `${COLLECTION_GRANT_PREFIX}file`, when: 'to list attachments' },
    ],
  },
  'document.search': {
    title: 'Search document contents',
    summary: 'Finds words inside saved files and attachments, with excerpts and file links.',
    needs: [
      { entry: `${COLLECTION_GRANT_PREFIX}file` },
      { entry: 'core.storage.data-file-read', when: 'to read text and verify saved matches' },
      { entry: 'core.storage.file.read-temp', when: 'to read converted documents' },
    ],
    note: 'Uses installed MarkItDown or Docling when conversion is needed. Shows files it could not search.',
  },
  'document.read': {
    title: 'Read a document',
    summary: 'Reads the text of a file, like an email attachment or a stored PDF.',
    needs: [
      { entry: `${COLLECTION_GRANT_PREFIX}file` },
      { entry: 'core.storage.data-file-read', when: 'for a plain text file' },
      { entry: 'core.storage.file.read-temp', when: 'for a document it converts' },
    ],
    note: 'To convert a document, the MarkItDown or Docling pack must be installed, with its convert switch on.',
  },
  'calendar.search': {
    title: 'Search your calendar',
    summary: 'Finds events by title, place or who is coming.',
    needs: [{ entry: `${COLLECTION_GRANT_PREFIX}calendar` }],
  },
  'memory.search': {
    title: 'Search your memory',
    summary: 'Finds facts and notes saved in your memory.',
    needs: [{ entry: 'core.memory.read' }],
  },
  'memory.write': {
    title: 'Save to your memory',
    summary: 'Saves a fact to your memory. You can see it and undo it.',
    needs: [{ entry: 'core.memory.write' }],
  },
  'memory.forget': {
    title: 'Forget a saved fact',
    summary: 'Forgets a fact the AI saved earlier. You can bring it back.',
    needs: [{ entry: 'core.memory.write' }],
  },
  'enrichment.search': {
    title: 'Search worked-out facts',
    summary: 'Finds facts Recued worked out about records, like a score or a summary.',
    needs: [],
    note: 'Each kind of fact also needs its own switch on the Entities tab.',
  },
  'deal.search': {
    title: 'Search CRM deals',
    summary: 'Searches the deals copied from your CRM.',
    needs: [{ entry: `${COLLECTION_GRANT_PREFIX}contact`, when: 'to show the contact on a deal' }],
    note: CRM_LIVE_NOTE,
  },
  'account.search': {
    title: 'Search CRM accounts',
    summary: 'Searches the companies copied from your CRM.',
    needs: [],
    note: CRM_LIVE_NOTE,
  },
  'work.search': {
    title: 'Search tasks, notes and more',
    summary: 'Finds tasks, notes, commitments, projects, bookings and things you own.',
    needs: WORK_READ_NEEDS,
  },
  'work.read': {
    title: 'Read a task, note or more',
    summary: 'Reads one task, note, commitment, project, booking or thing you own in full.',
    needs: WORK_READ_NEEDS,
  },
  'situation.query': {
    title: 'Ask what is going on',
    summary: 'Gets a short, ranked picture of what is going on around a time.',
    needs: [{ entry: 'core.situation.read' }],
    note: 'Each kind of item in the picture also needs its own read switch and data switch.',
  },
  'work.type': {
    title: 'Look up a type of thing you own',
    summary: 'Tells an AI which dates and reminders a type of thing has, such as a passport, before it adds one.',
    needs: [{ entry: 'core.work-entity.asset.create' }],
  },
  'work.create': {
    title: 'Add a task, note or more',
    summary: 'Adds a task, note, commitment, project or thing you own.',
    needs: [
      { entry: 'core.work-entity.task.create', when: 'to add tasks', kind: 'task' },
      { entry: 'core.work-entity.note.create', when: 'to add notes', kind: 'note' },
      { entry: 'core.work-entity.commitment.create', when: 'to add commitments', kind: 'commitment' },
      { entry: 'core.work-entity.project.create', when: 'to add projects', kind: 'project' },
      { entry: 'core.work-entity.asset.create', when: 'to add things you own', kind: 'asset' },
    ],
  },
  'calendar.create': {
    title: 'Add a calendar event',
    summary: 'Adds an event to your calendar.',
    needs: [{ entry: 'core.data.calendar.create' }],
  },
  'calendar.update': {
    title: 'Change a calendar event',
    summary: 'Changes an event on your calendar.',
    needs: [{ entry: 'core.data.calendar.update' }],
  },
  'work.update': {
    title: 'Change a task, note or more',
    summary: 'Changes a task, note, commitment, project or thing you own, or ticks a task off.',
    needs: [
      { entry: 'core.work-entity.task.update', when: 'to change tasks', kind: 'task' },
      { entry: 'core.work-entity.note.update', when: 'to change notes', kind: 'note' },
      { entry: 'core.work-entity.commitment.update', when: 'to change commitments', kind: 'commitment' },
      { entry: 'core.work-entity.project.update', when: 'to change projects', kind: 'project' },
      { entry: 'core.work-entity.asset.update', when: 'to change things you own', kind: 'asset' },
      { entry: 'core.work-entity.task.mark-done', when: 'to tick a task off', kind: 'task' },
    ],
  },
  'file.search': {
    title: 'Search your files',
    summary: 'Finds files in your connected folders.',
    needs: [{ entry: `${COLLECTION_GRANT_PREFIX}file` }],
  },
  'recipe.run': {
    title: 'Run a recipe',
    summary: 'Runs one of your recipes.',
    needs: [],
    note: 'Each step of the recipe needs its own switch here, unless the recipe is on under Recipes.',
  },
  'recipe.stop': {
    title: 'Stop a recipe',
    summary: 'Stops a recipe run that the same conversation started.',
    needs: [],
  },
  'schedule.run_prompt': { title: 'Schedule an AI request', summary: 'Runs a saved request later in its own conversation.', needs: [{ entry: 'core.schedule.prompt' }] },
  'schedule.list': { title: 'Read scheduled requests', summary: 'Lists saved requests and their timing.', needs: [{ entry: 'core.schedule.prompt' }] },
  'schedule.update': { title: 'Edit a scheduled request', summary: 'Changes the saved request or its timing.', needs: [{ entry: 'core.schedule.prompt' }] },
  'schedule.pause': { title: 'Pause a scheduled request', summary: 'Stops future and queued occurrences. A turn already running can finish.', needs: [{ entry: 'core.schedule.prompt' }] },
  'schedule.resume': { title: 'Resume a scheduled request', summary: 'Starts future occurrences of a paused request.', needs: [{ entry: 'core.schedule.prompt' }] },
  'schedule.remove': { title: 'Remove a scheduled request', summary: 'Removes future and queued occurrences. The conversation and its history remain.', needs: [{ entry: 'core.schedule.prompt' }] },
  'recipe.schedule': {
    title: 'Schedule a recipe',
    summary: 'Sets a recipe to run later or on a timer.',
    needs: [{ entry: 'core.schedule.recipe' }],
    note: 'Only you can schedule, from your own chat. An AI app that connects with a key cannot.',
  },
};

// ────────────────────────────────────────────────────────────────
// The data switches (`data.<collection>`)
// ────────────────────────────────────────────────────────────────

/** Every collection a contract can switch, by name: `READABLE_COLLECTIONS` and the
 *  situation history (`SITUATION_HISTORY_COLLECTIONS`). */
export const COLLECTION_GUIDE: Readonly<Record<string, GrantSwitchText>> = {
  mail: t('Your mail', 'Lets an AI or a recipe read the copy of your mail on your server.'),
  calendar: t('Your calendar', 'Lets an AI or a recipe read your calendar events.'),
  file: t('Your files', 'Lets an AI or a recipe read your stored files, like email attachments and files in your folders.'),
  contact: t('Your contacts', 'Lets an AI or a recipe read your contacts.'),
  task: t('Your tasks', 'Lets an AI or a recipe read your tasks.'),
  note: t('Your notes', 'Lets an AI or a recipe read your notes.'),
  commitment: t('Your commitments', 'Lets an AI or a recipe read your commitments: promises you made, or ones made to you.'),
  project: t('Your projects', 'Lets an AI or a recipe read your projects.'),
  booking: t('Your bookings', 'Lets an AI or a recipe read your bookings.'),
  asset: t('Things you own', 'Lets an AI or a recipe read the things you keep track of, like a car or a device.'),
  form_response: t('Form answers', 'Lets an AI or a recipe read the answers to your forms.'),
  webhook: t('Webhook messages', 'Lets an AI or a recipe read the messages other websites sent to your server.'),
  episode: t('Past episodes', 'Lets an AI see past times you did something: when, where and with whom. It sees them only inside a situation.'),
  occasion: t('Occasions', 'Lets an AI see the things that come back each year, like a birthday dinner. It sees them only inside a situation.'),
};

// ────────────────────────────────────────────────────────────────
// Lookups
// ────────────────────────────────────────────────────────────────

/** The text for one grant entry key, when Recued wrote one: an AI tool
 *  (`primitive.<tool>`), a data switch (`data.<collection>`) or a Recued
 *  operation (`core.*`). Undefined for a pack's own operation, a recipe or a topic,
 *  which carry their authors' own descriptions. */
export const grantSwitchText = (entryKey: string): GrantSwitchText | undefined => {
  if (entryKey.startsWith(PRIMITIVE_GRANT_PREFIX)) {
    return (TIER1_TOOL_GUIDE as Readonly<Record<string, Tier1ToolGuide>>)[
      entryKey.slice(PRIMITIVE_GRANT_PREFIX.length)
    ];
  }
  if (entryKey.startsWith(COLLECTION_GRANT_PREFIX)) {
    return COLLECTION_GUIDE[entryKey.slice(COLLECTION_GRANT_PREFIX.length)];
  }
  return Object.prototype.hasOwnProperty.call(KERNEL_OP_GUIDE, entryKey)
    ? KERNEL_OP_GUIDE[entryKey]
    : undefined;
};

/** The AI tools that check `entryKey` before they act, with when they need it. The
 *  reverse of `TIER1_TOOL_GUIDE[...].needs`, so switching a need off can say which
 *  tool stops working. */
export const toolsNeedingSwitch = (
  entryKey: string,
): ReadonlyArray<{ readonly tool: Tier1ToolName; readonly when?: string }> => {
  const out: Array<{ tool: Tier1ToolName; when?: string }> = [];
  for (const [tool, guide] of Object.entries(TIER1_TOOL_GUIDE) as Array<[Tier1ToolName, Tier1ToolGuide]>) {
    for (const need of guide.needs) {
      if (need.entry !== entryKey) continue;
      out.push(need.when === undefined ? { tool } : { tool, when: need.when });
    }
  }
  return out;
};
