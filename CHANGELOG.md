# Changelog

All notable changes to the public Recued source distribution will be recorded here.

Versions are calendar-based (`yy.m.d`, US Pacific) and name the day the source
checkpoint was cut. One entry per published export; the machine-readable
provenance for each — source commit, tree, payload digest, and what was omitted
— lives in `.recued-public-export.json`.

## 26.10.9 — 2026-10-09

Pi and OpenCode join Codex and Claude Code. Each has a pack, and the Issue
Pipeline can now work your GitHub issues with any of the four. Programs Recued
runs for a pack no longer see your server's secrets, and a new server's first
connections are encrypted from the start. Signing in to a built-in provider
such as HubSpot, Google or Salesforce works from a localhost address. Workflows
that hand a text file to AI, such as receipt capture and transcription, work on
a normal setup.

⚠ A connection saved in a new server's first session, before its first
restart, stopped working after that restart. Updating does not repair it: save
it again.

⚠ Workflows that hand a text file to AI now send that text to the AI you set
up, which can be a free provider. That was always their design; until this
release they failed before sending anything.

⚠ The Pi and OpenCode packs, the Issue Pipeline pack, and the new versions of
Codex Issue Pipeline and Solo Developer Workbench need this release. A server on
26.10.8 or older refuses them before installing anything, so update the server
first.

### Added

- **Pi and OpenCode packs.** Each runs its tool on a local repository: it shows
  the tool's status, runs a task, continues the last or a chosen session, writes
  a commit message and reviews your changes. Neither tool has a sandbox, so
  every run asks you first, and its description says the agent can reach
  whatever your account can. A repository's own settings stay out unless you
  turn on the actions that let them in. Recent OpenCode versions run plugin
  code included in a repository even so, and the pack says so.
- **The Issue Pipeline works your GitHub issues with Codex, Claude Code, Pi or
  OpenCode.** Each keeps its own branch, worktree and sessions, and picks up an
  issue's session where it left off. A Pi or OpenCode session continues only in
  the folder it worked in: if you moved the worktree, the issue says so and
  nothing runs.

### Changed

- **Installing a pack checks every pack it brings before installing any.** If
  one would be refused, the install dialog says why before you press Install,
  and nothing is installed. A pack that needs a newer Recued says so.
- **HubSpot's connection form** asks how you want to connect: a Service Key
  (recommended) or your own HubSpot app (advanced), with a guide for each. A
  pack that needs HubSpot accepts a Service Key connection.
- **Server logs.** The server's own log file is capped at about 10 MB, whether
  it started at login or with `recued start`, each line carries its time, and
  `recued logs -f` follows it on Windows too.
- **The web app.** Chat and Data are easier to move around on a phone,
  contrast and control sizes are fixed, toolbar labels are no longer cut off,
  Saved views show their state while the list is folded, and a Mail
  investigation's context opens as an expandable message.

### Fixed

- **Programs Recued runs for a pack no longer see your server's secrets.**
  Command-line tools, coding agents included, and the services a pack installs
  inherited the server's whole environment: the passphrase that unseals its key
  file, and your AI providers' API keys. They now inherit none of Recued's own
  environment variables.
- **A new server's first connections are encrypted.** A connection saved before
  the server's first restart was stored without its own encryption, though
  inside the encrypted database, and failed after the restart.
- **Signing in to a built-in provider from a localhost address.** HubSpot,
  Salesforce, Pipedrive, QuickBooks, Google, Dropbox, OneDrive, Box and
  SharePoint all ended "Authorization did not finish". A Salesforce sandbox
  sign-in now stays in the sandbox. At 127.0.0.1, the form tells you to connect
  from localhost instead, which providers accept.
- **A mistyped HubSpot Service Key is caught when you save it,** and replacing
  a key with a new one works. Any key passed the old check, and every
  replacement was refused.
- **Opening the HubSpot pack** runs its view with the connection the pack is
  bound to, instead of showing an error.
- **Workflows that hand a text file to AI work.** Receipt capture, invoice
  intake, transcription and meeting workflows sent the text as a document,
  which a normal AI setup refuses, and failed every time.
- **Invoice Book** marks hours as billed when it pulls them into an invoice, so
  they cannot be billed twice, and deletes an invoice item that came from hours.
  Both had been broken since 26.9.25.
- **Client Document Intake** sends a new chase whenever the list of missing
  documents changes. A chase for a different list of the same length was never
  sent.
- **Fundamentals Watch** stores each period's figure. It stored nothing, and
  now keeps a quarter's own figure rather than the year to date; a year-to-date
  figure already stored as a quarter is corrected.
- **The company news brief** shows the stories it finds. It showed none.
- **Google Calendar focus blocks and Reschedule** check that the time is free.
  They looked up free/busy and booked anyway. Now a booked time stops the change
  unless you allow overlaps, and the card names the times that clash.
- **Entrust Identity Verification** describes each kind of report and which
  watchlist category matched, and the watchlist-monitor brief drops a column
  that was always empty.
- **A refusal from a pack's own data** is reported as what it is, not as "check
  your connection", and automation no longer retries it as if the network had
  failed.
- **A Mac server started at login keeps its log.** It kept none, and `recued
  logs` found nothing.
- **A tool that stops making progress is flagged** even while the system trims
  its memory, and one that starts a new process as the last one ends is not
  flagged while it works.
- **A server run from a source checkout** starts under a system-wide Node, and
  two such servers on one Node no longer block each other.

## 26.10.8 — 2026-10-08

Recued now acts on the email it already reads. Bills, parcels, subscriptions,
reservations, orders and calendar invites each start a workflow that keeps
track of what the email means: a bill's due date, a return window, a booking,
an invite on your calendar. None of them uses AI. Calendar times are now right
wherever you are: CalDAV calendars keep each event's time zone, all-day events
stay on their own days, and the calendar workflows read your day on your clock.
A Claude Code pack joins the Codex pack, and `recued unlock` works again.

⚠ The first sync after you update reads every CalDAV event once more. It
corrects events that were stored hours off or under the wrong ID, and starts no
workflow while it does. All-day events stored off their days are corrected too.

⚠ Focus Block Proposer's working hours are now in your time zone. If you had set
them in UTC to match your day, set them back to your own hours.

⚠ `recued lock` and `recued auth-status` are retired. Both had failed since
26.8.1, and they now say what to use instead. `recued unlock` takes only your
24-word recovery key.

⚠ The updated calendar workflows need this release. A server on 26.10.6 or older
refuses them, so update the server before you update the workflows.

### Added

- **Workflows that start on your email.** One pack per kind of email, and none
  of them uses AI:
  - **Bills** turns a bill into a reminder due on its due date. A later email
    that changes the date or the amount updates it, and one that says the bill
    was paid closes it.
  - **Parcels** opens a 30-day return window when a parcel is delivered.
  - **Requests by email** makes a task or a note when you email your own address
    with `+task` or `+note` before the `@`, linked to the thread.
  - **Subscriptions** lists the subscriptions your mail shows, and turns a
    renewal or a trial that is ending into a decision due by its date. A price
    change starts the price-increase check.
  - **Bookings** turns a reservation into a booking with its time, price and
    confirmation code, and moves or cancels it when a later email says so. Two
    emails about one reservation make one booking. Travel-day prep now checks
    the stays and trips in your mail.
  - **Receipts** watches for the refund of a cancelled order, and the monthly
    receipts packet lists the month's orders and bills.
  - **Calendar Invites** turns an appointment invite into a booking, puts an
    invite on the calendar you choose, reminds you to answer, and tells you when
    someone answers an invite you sent or cancels one you received. An update
    moves the event; a cancellation or your decline marks it cancelled. Mail
    keeps the invite from Google, Outlook and other senders, and one invite
    starts one run.
- **A Claude Code pack** runs Claude Code on a local repository, sandboxed like
  Codex. It checks that Claude Code is signed in, runs a task, continues the
  last or a chosen session, writes a commit message and reviews your changes.
- **The Codex pack** returns Codex's own answer, lets one command run for up to
  45 minutes, continues the last or a chosen session, reviews your uncommitted
  changes, and can commit each issue (off unless you turn it on).
- **`recued status` says why the last start failed**, for a server started at
  login or by systemd, where there is no terminal to show the error.
- **For workflow authors:** `date_period`, `date_format` and `date_parse` take
  `time_zone` (pass `{{context.server.time_zone}}`); `date_period` adds
  `tomorrow` and a `date` to measure from; `event_when` says when a calendar
  event happens, all-day or not. A table column can name a field inside each
  row, such as `value.score`.

### Changed

- **Calendar workflows read your day on your clock.** Today, the morning brief,
  the daily note, the end-of-day review, the weekly report, meeting notes, the
  conflict detector, focus blocks, travel-day prep, meeting prep, follow-ups,
  meeting alerts and Reschedule show times in your time zone and an all-day
  event as "All day", on its own day. An all-day event no longer counts as
  hours booked, and an alert before one no longer calls it a meeting.
- **An approval for a change that stays in Recued** (a booking, a commitment,
  an event on Recued's own calendar) says so, and shows its times as dates in
  your time zone instead of numbers.
- **The attention tray says how long each ask has waited.**
- **A trigger says in words what starts it**, filter included ("when a calendar
  invite arrives"). The raw pattern moves to the trigger's details.
- **Installing a pack** lists each workflow only under the access level that
  lets it run.
- **Data → Calendar** marks cancelled and tentative events, offers no Reschedule
  for a cancelled one, and reschedules an all-day event by its days.

### Fixed

- **CalDAV calendars** (Apple, Fastmail, Nextcloud and others) read each time in
  its own time zone. Events from Apple, Outlook-style zones and floating times
  were stored hours off. An event with an alert is no longer filed under the
  alert's ID. An edit changes only what you changed in the server's file, so the
  event keeps its zone, alerts and deleted dates, and moving one occurrence of a
  repeating event moves only that one. Changes and deletions made on the server
  now reach Recued.
- **All-day events stay on their days.** Data → Calendar listed a 24 December
  holiday under 23 December west of UTC, Today dropped an Outlook all-day event
  after midnight UTC, and a reminder "a day before" a holiday fired at 4 pm two
  days before. An all-day event created by a form or by your AI landed on the
  wrong day.
- **Moving an event reaches Google and Outlook.** Reschedule and an invite update
  changed nothing there, and Outlook placed an event in another time zone at the
  wrong hour. An invite's event is now created in your time zone, not UTC, and a
  stay with no time is booked on your day, not the server's.
- **`recued unlock` reaches the server again.** It had failed with "401" since
  26.8.1. It reads the recovery key without showing it, and accepts it from a
  pipe.
- **Windows installer.** Installing the x64 build on an ARM PC no longer fails at
  the last step on a file Windows still holds, and a fresh install that fails
  never leaves files that look finished.
- **Workflows that flag something as upcoming, past or a number of days old**
  work it out again on every run. They had been replayed from a cache for as
  long as the list they read stayed the same.
- **A table on a reception page, or in the server's text output,** shows a
  column that names a field inside each row. It showed "—".

## 26.10.6 — 2026-10-06

A Home Assistant pack lets you check on and control a self-hosted Home Assistant
from chat or a workflow, and its camera check asks your AI about a picture once
Test connection shows a model can see one. Workflows that read your mail and
calendar now read the mailboxes and calendars you have, meeting reminders see
every meeting, and the automatic workflows 26.9.30 stopped get their timers
back. Chat follows a held action through to its answer, an approval says what
it would change, and personal data stays protected in more places. The old mail,
file, calendar, webhook and workflow watchers are retired in favour of triggers.

⚠ If you updated to 26.9.30, an automatic workflow you had paused may start
again: 26.9.30 lost the switches that said which were paused. A one-time notice
lists the workflows that now run, so you can switch any of them off in
Automation.

⚠ A workflow you wrote yourself that uses one of the retired watchers stops at
its trigger. Checking the workflow names what to use instead.

⚠ If apt reports signature errors on a Linux server you installed as root, an
earlier first boot replaced `/dev/null` with a regular file. Reboot, or run as
root: `mknod -m 666 /dev/null.new c 1 3 && mv -f /dev/null.new /dev/null`.

### Added

- **Home Assistant.** A new pack connects to your self-hosted Home Assistant
  with a long-lived access token. It reads states, history, the logbook,
  calendars and camera snapshots; runs everyday controls (lights, switches,
  climate, locks, media, scenes) straight away when you ask in your own chat or
  run them yourself, and asks first when another app, another person or a
  schedule does; and always asks before unlocking a door, disarming an alarm,
  opening a cover such as a garage door, or calling any other service. An
  approval names the device it changes. Its workflows check device health, check
  the house before you leave, report weekly energy use, and control a device by
  its name.
- **A camera check asks your AI about a picture.** It takes a picture from one
  camera and asks a yes-or-no question about it ("is someone at the door?"),
  alerting on yes, or also when it cannot tell. Run it by hand, from chat or on
  a schedule that a motion sensor can gate. The **Home Assistant Camera Alerts**
  pack lets a Home Assistant automation start it through a webhook; what Home
  Assistant sends can only choose a camera and one of the questions you listed,
  never write the words your AI reads. Each snapshot is kept as a file in your
  data.
- **An AI model can be shown pictures once Test connection proves it can.** Test
  connection now also shows the model a small test picture, and a model that
  reads it back is used for steps that send a picture. A pack can keep the files
  it captures, such as camera snapshots, out of the background AI passes.
- **Chat can schedule a workflow**, once or on a repeating schedule, through the
  same checks as the Run dialog; its schedules are listed in Automation. Only you
  can, from your own chat, messenger or local CLI.
- **A trigger can follow a dish's setting**, so a workflow starts only for the
  folder, mailbox or calendar that dish names, and changing the setting re-points
  the trigger. File Toolkit gains **Notify when a file arrives**.

### Changed

- **Follow this work** investigates from the current mail: it rereads the linked
  mail and searches related mail before it answers, quotes the exact passages it
  relies on, and ends with numbered steps that say which need your approval,
  plus open questions. Nothing is created or run until you choose. With **Keep a
  running note** on, chat keeps the mail it read and the last plan, encrypted,
  and refining edits that plan.
- **Retired:** the mail, file, calendar, webhook and workflow watchers, the
  `on_failure` field (it never ran) and the starter templates. No shipped
  workflow used them; triggers on mail, files, calendar changes, a workflow's
  runs and webhooks replace them. The time, time-before-an-event and web-page
  watchers stay.
- **A missing value is never a number in a comparison.** Greater-than and
  less-than comparisons with a missing or blank side are now false, so a missing
  amount no longer passes "less than or equal to 0".
- **A timer says when it really runs**: its time window, or what it waits for,
  in Workflows, Automation and Kitchen. A timer's window now opens in your
  server's time zone, as schedules already did.
- **An approval says what the held action would change**, in the tray and on the
  Approvals page, even when the action lists no reviewable fields; a field named
  like a secret is shown with its value hidden.
- **Chat reaches what its contract grants**, including the actions of installed
  packs, and each call is still checked against its risk and approval. Chat no
  longer offers "Keep as dish".
- **A workflow's webhook follows its main dish**, and saving its settings, or
  making the dish through a schedule, a trigger or switching it on, tells you
  what that did to the webhook.
- **Personal data.** A field tagged `content` hides the contacts your server
  knows and every email address in the text before it reaches an AI, as chat
  does. A step's `pii_fields` also protect values that arrive through a
  reference, and a failed workflow's error message shows the real value instead
  of an alias, including in the audit log.
- **Installing from source** works under npm 12, verifies every package against
  its lockfile hash, and says Node 24 everywhere. `npm run build:binary` on
  macOS leaves a binary that runs, and the install steps say what to type on
  Windows.

### Fixed

- Workflows that read mail or a calendar defaulted to one named `primary`, so
  wherever you have none every run failed. Calendar workflows now read every
  calendar unless you choose one, and mail workflows ask which mailbox to read.
  If yours really is named `primary`, choose it once in the workflow's settings.
  Workflows from Personal Organizer Foundation that you already have, such as
  Today, keep their old copy until you install the pack again from
  Settings → Packs.
- Meeting reminders see every meeting, even with more than 500 ahead, fire for
  none from the past when installed, and read each meeting from the calendar it
  is in. A workflow switched off and on again no longer repeats its last reminder.
- Automatic workflows that 26.9.30 stopped get their timers back, on the dish
  they ran as. Switching one on is refused, with a link to Packs, while its pack
  is not installed.
- Web Watch runs on its own without asking for approval, and installs again.
- An approved or refused held action now reaches the chat: the answer says so
  when it finishes, and the chat stops calling it "awaiting approval". A
  reloaded conversation shows its tool calls instead of raw text.
- The AI extraction step now receives the instructions a workflow gives it. Four
  AI enrichments of your mail (role, company, related threads and topic) run
  once more in the background after the update.
- A label such as `{{item.name}} ({{item.id}})` stays text instead of becoming 0.

## 26.9.30 — 2026-09-30

Switching a workflow on now makes a dish. It asks for the workflow's settings,
and every trigger and schedule of that dish runs with them. A second dish of the
same workflow runs on its own settings, and installing a workflow no longer
starts anything. You can follow the work in a mail conversation and investigate
it in a chat that only reads. A workflow can bring a mail template for you to
keep, swap or copy. And releases and installs are harder to break: a release is
checked where you download it before it is called live, and an interrupted
install recovers to a matching pair.

⚠ An automatic (auto-run) workflow that ran on 26.9.29 stays stopped after this
update until you switch it on. The update takes a copy of your database first,
so rolling back to 26.9.29 restores it, including which workflows you had
switched off.

### Added

- **Dishes: a workflow runs once you switch it on.** Switch on opens the
  workflow's settings; confirming makes a dish and turns on every trigger the
  workflow declares, for that dish. Add another makes a second dish with its own
  settings, triggers, history and failures. Schedules belong to a dish and use
  its settings, and each run records the settings it ran with.
- **Running as**, on a workflow's page, lists its dishes with their state, what
  starts them, and their last and next run. **Automation** is one list by
  workflow and dish, with On, Off, Needs you and Failing filters and a Coming up
  view.
- **Follow this work.** Follow the work in a mail conversation, with AI briefs
  you review and correct, related threads, and an explicit resolution.
  **Investigate in Chat** opens the conversation's chat. The investigation reads
  the exact mail and its documents through the same privacy controls as the
  chat, can only read, and links the exact mail and dates in its answer.
- **Mail templates in workflows.** A workflow's mail template setting can bring a
  starter template: installing creates it with its AI off, an update re-applies
  it, and uninstalling removes it. Settings lists your templates of that kind,
  and Duplicate to edit makes your own copy. The install dialog lists the
  templates a pack brings and says where each workflow's facts come from.

### Changed

- **Installing a workflow starts nothing**, and an automatic workflow runs on
  one timer per dish. `auto_run.default_enabled` is ignored.
- **A release is checked where you download it.** Before a release is called
  live, every download is fetched from releases.recued.com and compared with the
  signed files. Publishing also refuses a release that would move you to an
  older version, or change the files of a version already out.
- **Sign-in comes back to every address that works**: your server's own https
  name, and app.recued.com's page again. Signing in to HubSpot, Salesforce or
  your own OAuth app, and the links in notices, find your server's address
  without `RECUED_PUBLIC_BASE_URL`.

### Fixed

- An install interrupted mid-swap is kept only if it is complete and is the
  release that install was bringing; otherwise the previous one comes back. A
  mixed old and new pair is no longer kept.
- On Windows, a new install is written to disk before the previous one is
  deleted, and a webclient update no longer replaces a good bundle with a
  half-deleted one when a file in it is in use.
- `recued self-test` no longer leaves a probe folder behind.
- Two IMAP accounts no longer share an attachment file.
- An approved document read goes through its reader.
- After an update, Settings → Updates says how it went. The embeddings and
  transcription slots choose a protocol. Messenger delivery keeps keyboard
  focus, and "Saved files" says its name.

## 26.9.29 — 2026-09-29

A large release. Recued can now learn to read a kind of email — a parcel, a
bill, a booking, an order, a lead — and a workflow can wait for what it reads.
Two new packs keep a meeting's loop going from its minutes. Fixes found while
driving the product live cover approvals, mail sends and due dates. And a date on
a task, promise, project or booking is now always stored as a date: dates that
had been stored as text are repaired once, when the server first starts, and a
date can now be removed, on your server and on a partner's. New tables hold the
mail facts; you can go back to 26.9.26, which leaves them unread.

### Added

- **Mail facts: Recued reads your email for facts, and a workflow waits for
  them.** Eleven built-in kinds — a purchase, shipment, return or refund,
  reservation, bill, statement, subscription, payslip or tax form, lead, order
  received, and a request you mail to your own server — plus kinds you make. The
  emails about one parcel, order or booking fold into one thing with a state.
  You teach Recued a sender's emails with a template made from an example email:
  click a value and it becomes a rule. Some emails need no template: schema.org
  markup and carrier tracking numbers are read as they are. An optional AI pass
  fills only the values a template allows, and hides your data from the model
  the way the chat does; Draft with AI proposes a template's rules, which then
  run without a model. A workflow subscribes with
  `{ "on": "mail_fact.<kind>", "fields": [...], "where": {...} }` and runs when a
  thing is created or a value it watches changes. It all lives under Data →
  Received → Mail facts; a template can read past mail; and Automation and
  Kitchen offer "A mail fact" as a trigger. A security notice is skipped before
  any template reads it, and reading a fact needs the same access as reading
  the mail.
- **Meeting Minutes.** Minutes you write become tasks in your federated projects
  and brief the next meeting. No model and no calendar.
- **Meeting Secretary.** One person keeps a meeting's loop from a minutes file:
  tasks proposed by AI, the minutes mailed, the next meeting prepared from the
  last minutes and progress, and the briefing mailed. The mails say when the
  meeting is in your own words and never invent a time. The briefing is written
  the way you ask, in the meeting's language, and keeps to a length you set.
- **A date can be removed.** Emptying a date in the edit dialog now removes it;
  it used to come back after Save. A task's due date is removed with
  `clear_due_at`. On a partner's server, removing a project's target date or a
  task's due date works too.
- **`stop_when`** lets a step end a run as a success when there is nothing more
  to do.
- **`core.storage.shared.patch`** changes named fields of a stored record in one
  step. The follow-up workflows use it, so two of them no longer overwrite each
  other's fields.

### Changed

- **A date is always stored as a date.** A task's, promise's, project's or
  booking's date given as text is converted when it names exactly one moment —
  a day, or a time with its time zone — and refused otherwise. Dates that had
  been stored as text are repaired once, when the server first starts, and you
  are told. A promise dated that way never came due.
- **Date settings.** A date-and-time setting is sent with your browser's time
  zone, and a new date setting asks for a day. Chat and MCP check a workflow's
  date values before it runs.
- **Chat's work tools put each field where its kind keeps it**: a project's
  description and target date, a promise's words and date. Creating a promise
  from chat used to fail every time.
- **A due set as a day is judged by its day**, in your time zone: Today, the
  Tasks filter, reminders and alerts no longer call it overdue the evening
  before.
- **A workflow that writes reads your records fresh**, and "now" is read on
  every run. A cached answer no longer decides a write.
- **Versions:** 75 recipes and 46 packs changed since they were last listed go
  up one, so an update offers the change.

### Fixed

- A partner could never change a date on your projects or tasks. Now they can.
- A federated task moved to a done state is done.
- Data → Files lists the files saved in Recued.
- A held run's result replaces its "held for approval" note once you approve it.
- A mail send that never left can be sent again, and one whose outcome is
  unknown asks you "Did this email go out?".
- An approval that covers a loop lists every call it runs. A held loop item can
  no longer be edited, since one edit reached every remaining item.
- The Cal.com meeting-outcomes packs store the promises a meeting produces;
  every one had been refused.
- A new mailbox's triggers work without a restart, and a restart no longer wakes
  triggers for mail, calendar events and files that did not change.
- Signing in to Gmail, Google Calendar and Outlook works from app.recued.com
  again, and Microsoft sign-in works with your own app.
- A Mac install needs no sudo. The installer is read in full before it runs, and
  the steps it prints work as printed. `recued status` answers correctly past a
  stale pidfile, and `recued version` prints the version.
- Chat shows when a turn is working, and Updates never hangs on a finished
  update.

## 26.9.26 — 2026-09-26

A smaller release. Installing a pack now tells you, before you choose anything,
when it needs another pack that is not installed and does not come with it, and
links to that pack. The enrichment that runs in the background now aliases your
data before it reaches a model, the way the chat does. And five watchers that
read mail and calendar events were reading fields the event never carries, so
they did nothing; they now read the record itself. No schema change: you can go
back to 26.9.25.

### Added

- **The install dialog says what a pack needs first.** When a pack's workflows
  call a pack that is not installed and that it does not bring in, the dialog
  says so before you choose anything ("This Pack needs Federated Projects. It is
  not installed, and this Pack does not bring it in."), with a "Get Federated
  Projects" link to that pack's own page, and holds Install. That pack's own
  dialog then asks what it may do. Such an install used to be refused only after
  you had made every choice, and it left the packs it brought in installed. The
  server now refuses it before anything is installed, whoever asks, and names
  every missing pack.

### Changed

- **OCRmyPDF brings PDFToText in with it.** Its notes workflow uses it, and the
  install was refused on any server that did not already have it. A server that
  has PDFToText keeps it as it is.
- **The install dialog no longer tells you to choose "Read + write" for a local
  tool another pack brings in.** Its commands are allowed in the tools dialog,
  whatever its Access, so the note was wrong either way.
- **A list you type with spaces reads as the list it spells, where the list can
  tell.** For a list of numbers or of choices, such as notification channels and
  weekdays, `slack email` is Slack and email, and `1 3` is Monday and Wednesday.
  A name that is not one is still refused by name, and an open list, such as
  tags, still needs commas.
- **An existing customer is someone with an open or won deal**, for the "new
  inquiry from an existing customer" notifications. A lost deal alone no longer
  counts, and a sender is also matched against the contacts mirrored from your
  CRM. The cross-vendor version no longer asks for HubSpot and Salesforce
  permissions it never used, so its update asks for nothing new.

### Fixed

- **Five watchers did nothing.** The contact timeline rollup, the three "new
  inquiry from an existing customer" notifications and the meeting reschedule
  tracker read the sender, or the meeting's start time and attendees, from the
  event, which carries only a pointer to the record. Each reported success and
  did nothing. They now read the record.
- **New mail was rarely enriched once a pass had finished.** A finished pass
  remembered the last message it walked, and new mail usually sorts before it.
  Each pass now starts over; it re-reads what it already did but spends nothing
  doing it again.
- **Daily Ops took a sender whose address merely contained yours for you**, so
  the unanswered-inbound radar dropped that thread from "waiting on you". It now
  matches your address exactly.
- **A pack you had not installed showed a Use tab** on a server running from a
  source checkout, and its view ran only to be refused because the pack was not
  installed. Such a pack now opens on its details and runs nothing, and a link
  to its Use tab lands there too.

### Security

- **Background enrichment now aliases your data the way the chat does.** It
  sent structured record content to the model as it was, and fell back to the
  raw input whenever aliasing failed. The whole content of each call is now
  aliased, keys included, and an aliasing error means no call is made: the
  record is retried and marked failed at the fifth attempt, and a task that
  works across many records pauses after three failed cycles in a row. This
  change does not cover AI steps in recipes, or documents.

### A note on upgrading

- There is no schema change, so going back to 26.9.25 is clean.
- Updating OCRmyPDF installs PDFToText if you do not have it.

## 26.9.25 — 2026-09-25

Three kinds of work dominate this release. An update now keeps what you chose —
who a pack is shared with, what it may write, which automations are on, which
public forms take submissions — instead of coming back with a fresh install's
answers, and it shows you what it will change before you press Update. A new
month-end closer books an imported bank statement into Ledger book and closes
the month against it, fed by a spreadsheet import you set up by pointing at your
file's own columns. And a pack view that would write, spend or send no longer
runs by itself when its tab opens; it waits for you to press it. One repair also
changes customers' access, once, on the first start: if you sell passes or enrol
students through DeepTutor, read the note on upgrading before you apply this
release.

### Added

- **A month-end closer books your bank statement into Ledger book.** The new
  pack installs Ledger book and Bank statement import with it; give both
  "Read + write". Link your bank account once, and "Month to close" shows the
  month side by side: booked, not booked, and the statement against the books.
  Up to 30 ticked lines book together or not at all, each entry named after its
  statement line so a line cannot be booked twice, with the amount read again
  from the imported statement rather than taken from the page. "Match lines
  typed by hand" pairs a line with an entry you already have when the amounts
  agree to the penny and the dates are at most seven days apart.
- **The closer suggests accounts from your own history first.** "Book as
  suggested" uses the account your earlier booking of the same description used,
  however old. "Suggest accounts with AI" asks your model only when you press
  it, only for lines your history cannot explain, and only among your open
  accounts in the bank's currency; any other answer is thrown away, and if your
  books cannot be read, nothing is sent.
- **Close the month against the statement.** Type the closing balance printed on
  the statement; the difference must be zero or come with a reason, and checking
  writes nothing and lists what stops the close. A sealed month refuses booking
  and matching, and unsealing or sealing again is one click. Ledger book itself
  is not locked, so the close screen tells you when something was posted after
  the seal. A month with more than 1,000 rows in any search the closer needs
  stops before anything is written.
- **Explain the month, and hand your accountant a package.** "Explain the month"
  lists the income and expense accounts that moved against last month by at
  least 50 and 5% (both are settings), and "Ask AI to explain" sends only lines
  with no explanation, or with an AI one written for other figures, so yours are
  never replaced. The package is a summary and every line of the month as CSV,
  money in and money out as separate positive columns, with your explanations,
  ready to copy. A month-end reminder, on a schedule you add, tells you when
  last month is not sealed or a sealed month has changed since, and is otherwise
  silent, including about a month you unsealed on purpose.
- **A guided spreadsheet import.** Bank statement import, Expense Ledger and
  Photo Attribution's roster now open a form, from a pack's Use tab or Run in
  Recipes, where you upload the file, match each field to one of its own header
  cells, and press Check, which runs the import on your server without recording
  anything and shows the first 10 lines as they would be stored. Before, the
  bank importer wanted six header names typed by hand, and a misspelt one
  imported every row with that field empty while reporting no failures.
  "Remember these columns" keeps the mapping.
- **Keep your version of a line, or take the file's.** "Keep what I already
  have", beside Import, is ticked by default. Unticked, the file updates only
  the columns it carries, such as a bank line's running balance or an expense's
  tax, category and note, and never your period, currency, account or card; an
  import nobody sees the box for, from chat or a schedule, keeps yours. Before,
  both importers refused every line you already had with different details, and
  uploading a statement again refused the lines it shared with an earlier
  upload.
- **Imports read a decimal comma, and the date format you name.** Under More
  options, the bank and expense importers ask for the decimal mark and a date
  format such as dd/mm/yyyy; before, `1.200,00` became 1.2 on every line of a
  European export, and dates were kept as written, which do not sort. A wrong
  decimal mark now leaves an amount unreadable rather than 100 times off, every
  amount that read correctly before reads the same, and a thousands mark you had
  saved as "." carries over as a decimal comma. Dates are stored as YYYY-MM-DD,
  a two-digit year must come last in the format, and a date that reads only in
  another order stops the import before anything is written. Setting a date
  format for a file you imported before brings its lines in again as new, which
  the setting warns you about.
- **Re-apply a package to its customers, choosing what and who.** Re-apply its
  permissions, its length, or both, to everyone still active, everyone nobody
  changed by hand, or the customers you tick; closed customers are always left
  alone, and nothing is written until you press Re-apply after a preview. End
  dates are set exactly, the customer's start plus the package's length, so they
  can shorten: a running pass whose length has run out ends now, then gets your
  grace period, and one whose access has already ended is left alone unless you
  pick it. Whether a date or an agreement was changed by hand is recorded from
  now on (customers from before then are compared with the package). It is on
  the package's new Re-apply tab, which replaces "Give everyone the new
  package", and as "Re-apply their package" on a customer's page.
- **Open a quote request by hand.** Most quote requests arrive by phone or in
  person, so "Open a quote request by hand" takes the customer's email, what
  they asked for and a reference, and sends nothing; "Price and send a quote"
  prices either kind. It comes with Seller Quote Request 4.
- **A pack can bring saved views of its own.** An installed pack may add up to
  20 Data views on an allowance of their own, so your 100 are untouched, listed
  in Saved views in a group named after the pack. The pack keeps each view's
  name and settings, so you cannot rename or delete one, but you can hide it,
  and the alert and review mark on it are yours.
- **When an update replaces a saved view you had set up, it asks first.** A pack
  view is known by its name, so a renamed view arrives as a new one. The old
  one, if you had set it up, is retired rather than deleted, its alert stopped
  and its settings kept, and Saved views asks whether to set up the new view the
  same way, keep the old one as your own, or dismiss.
- **More pack lists open the row they show**, among them Client Document
  Intake's "Accept documents in bulk", Shortcut (with a new story detail page),
  PandaDoc and Wise. Honeycomb's Open control, added earlier, is now offered to
  packs already installed.
- **For recipe authors: a Records search can read every page, and the annotation
  and link steps work.** A search step that sets `pages: "all"` reads up to
  1,000 rows instead of one page of at most 200. Listing, searching and deleting
  annotations and links existed only in testing and failed on every real run;
  they work now, and a delete refuses a filter key it does not know, or a field
  that resolved to nothing, rather than deleting more than was named. The old
  annotate and link steps are retired in favour of the create steps, and a
  recipe can now retire one of its own settings by name and say what its saved
  value still means.
- **Packs for 49 vendors follow what those vendors publish today, and several
  gain operations.** New: a Continuous Integration - Vercel pack that reads CI
  runs, jobs and their logs and can retry a run; OneSignal's Journey Builder;
  ten Make operations, among them connection and key locking, adopted after
  seven weeks on hold; 36 operations across Deel's ten packs; and Personio's
  recruiting operations, now out of beta. Further additions reach Confluent,
  Aiven, Render (holding out the eight new operations that return environment
  variables or secret files), Pulumi Cloud, Ashby, GitBook, PlanetScale,
  Zendesk, Fivetran, Statsig, Hightouch, Close, Outreach, ClickHouse Cloud,
  Apollo, Hetzner Cloud, Honeycomb, LaunchDarkly, PandaDoc, Temporal Cloud and
  Vercel. Attio's 20 new routes are held for review.

### Changed

- **A pack view that would write, spend or send now waits for you to press it.**
  A view runs by itself when its tab opens and whenever its pack's data changes,
  and the check that allowed this never looked at built-in steps: 49 shipped
  views held a write, such as a mail send or a shared-record delete, and 114
  called the built-in AI. Each view is now asked whether it changes anything and
  whether it costs anything to run again, a notification counting as a change,
  and 173 views and one lookup became buttons. A webclient that cannot get that
  answer from the server treats the recipe as spending, so an older server
  cannot turn a view back on.
- **Operations a vendor bills per call are marked, and a view that calls one
  waits for you too.** Eighty-two operations now carry the mark: AI generation
  and embeddings, reranking, transcription and speech, paid search, scraping,
  crawling and computation, and data-enrichment credits. Seven shipped views
  called one, among them four Tavily views, Exa search and Wolfram Alpha, and
  they are buttons now, as a view calling the built-in AI already was. The mark
  decides only when a view runs; no cost is counted anywhere.
- **The update dialog shows what it will change.** It used to show only the
  operations you had set rules for; it now lists those first, then everything
  Added, Changed and Removed, and names each public form or link that would
  stop, each automation it would switch off, and each saved setting the new
  version no longer uses. There is no rename: a removed operation keeps your
  rule for it, doing nothing in case it comes back, and its replacement arrives
  at the pack's defaults.
- **Uninstalling a pack removes what its recipes leave behind.** It used to
  delete the recipes but keep their install settings, named setups, schedules,
  your triggers and auto-run, so schedules failed "recipe not found" every time
  they fired and a reinstalled recipe came back tripped. They now go with the
  recipe, on uninstall, on an update that drops it and on a delete, and the
  Delete confirmation lists them; connections and shared settings groups stay. A
  recipe the server still bundles is left installed, with its settings,
  schedules and triggers.
- **A notification goes to every channel you have set up, and in-app is built
  in.** A reminder that named no channel went to a fixed list, so every channel
  you had not set up reported a failure, and in-app needed a connection nobody
  could add. A channel setting left empty now means every channel you have set
  up, rather than in-app alone, and four recipes and eleven packs that notified
  without saying so now say so when you install or update them.
- **Weekdays and notification channels are checkboxes.** Weekday settings wanted
  "1, 2, 3, 4, 5" typed, with nothing saying 1 is Monday, and channel settings
  wanted channel names; they are now boxes, Mon to Sun and Slack to In-app. No
  channel ticked means every channel you have set up, while a weekday list with
  none ticked is refused before it is saved, since the recipe would never run. A
  server still on 26.9.21 installs these recipes too, and keeps the text box.
- **Today and Saved views have pages of their own.** Today, which gathers tasks,
  commitments and calendar across sources, moves to `#today` with its own place
  in the drawer and can no longer be saved as a view, and Data now opens on
  Contacts; a saved view that opened Today ("My day") opens `#today` instead.
  Saved views moves to `#views`, between Contacts and Data in the drawer. Old
  addresses, including links in notifications already delivered, still open.
- **In Seller, a row's preview shows the item itself.** It used to describe the
  list: its name, the record's id and the page number. It now shows the item's
  own details (for a package, who is on it, its pass, its limits and its source)
  and one button that opens it. On a package, the "Customers" tab is now
  "Re-apply", and on a phone the re-apply preview no longer runs off the screen.
- **The tool list and the recipe list arrive in pages.** Each was one message
  with a row per installed tool or recipe, and on a server with 1,051 packs the
  two together came within 256 KB of the 16 MiB at which the connection gives
  up. Both now come in pages of at most 1 MiB, and the tool list no longer
  carries each tool's full argument schema, which the screen reading it never
  used and which was more than half its size; the model that calls a tool still
  gets it. An older webclient, which does not ask for pages, still gets whole
  lists.
- **What a vendor withdrew or renamed leaves its pack.** Daytona withdrew
  account unlinking and SMS two-factor enrolment, renamed its account-providers
  read, and now takes 15 paging parameters as text ("100"); Make withdrew its
  LLM configuration and cashier products and moved two sets of routes, which
  renames their operations; Zendesk, PlanetScale, Outreach and Wise each
  withdrew writes, and Wise's v2 business-profile pair ships again; Deel renamed
  its IT asset and order reads; and LaunchDarkly folded AI Configs into
  AgentControl without changing their permission levels. A renamed operation
  appears in the update dialog as Removed plus Added, and a rule you set on the
  old name is kept but does nothing.
- **Northflank's operations ask for a team, and Samsara's attribute update is
  admin.** Northflank shipped each operation twice, for the key's default team
  and for a named team; only the named-team form ships now, so each of its
  eleven workflows asks for the team at install. Samsara's attribute update is
  admin rather than write, as its pack intended, so a delegation rule for writes
  no longer covers it. Three Samsara hub-location operations carry the vendor's
  notice to use places instead: closed to new customers on November 1, 2026,
  removed on November 1, 2027.

### Fixed

- **An input a recipe left out reached built-in steps as an empty value, and
  shipped recipes broke on it.** The paid-pass recipes and the free DeepTutor
  enrolment gave access with no end (see the note on upgrading); four
  plan-change recipes were refused on every Stripe, Paddle and Lemon Squeezy
  change; eleven recipes read an empty calendar while reporting it fresh;
  creating or updating a project, and all 16 work-item lists, failed; and link
  and annotation deletes reported success having deleted nothing. A left-out
  input is now dropped before the step sees it, and the refused plan changes
  repair themselves wherever the provider's reconciler runs. Updating a booking
  without naming its slot wiped the slot, and that cannot be repaired or even
  detected: a slot may be empty by design, and no copy of the old one was kept.
- **Twenty-six shipped recipes had a step that could never succeed**: summaries
  passing the wrong input names, digests passing a body where the notification
  step needs text, and enrichment lists with no topic. All are repaired and
  republished. The recipe checker now looks at every step and warns, rather than
  refusing, when a step lacks an input its type requires, because a server
  refuses a whole recipe over one error and that would stop recipes that run
  today.
- **A pack update keeps every choice you made.** An update re-ran the install,
  and whatever it did not carry came back as a fresh install's answer: it
  withdrew the pack from every customer and agreement, turned a revoke for one
  agreement into a grant, moved an owner with two accounts to the first one
  matching by name, and took a "Read + write" pack's writes away unless you
  re-picked, which broke Bank statement import's importer. The dialog now starts
  at the pack's current audience, account and Access, never higher, and door
  scopes, command-line allow-lists, AI-token operation lists, customer templates
  and grants set by hand stay as set. Operations an update adds reach only the
  pack's existing share, and re-reviewing a generated MCP pack no longer narrows
  it back to Read, only you.
- **An update no longer stops what was already working.** A saved setting that
  an update dropped made every run refuse; it is now set aside, and kept in case
  a later version wants it back. A public form or booking link refused every
  visitor after any update, even a one-step fix, until you bound it again in
  Reception; it now keeps working, Records pack updates included, unless its
  form fields or the offer it sells changed; a door that needs fewer permissions
  is re-made without asking, and one that needs more waits for you. An update
  that changed a trigger created its replacement switched off; when one trigger
  becomes one other, the replacement now keeps your on/off state, settings,
  continuity and poll interval, and never switches on what you had off.
- **Installing a pack no longer updates a Records pack you already have behind
  your back.** A pack that needed a newer Records pack updated it as part of its
  own install, skipping that pack's update review and resetting it to its
  defaults: installing Seller Quote Payment Events would have dropped your quote
  requests from "Read + write" to "Read only" and ended their share with your
  agreements. The install now stops before writing anything and tells you to
  update that pack first from Packs, and the install dialog warns you before you
  press Install; a pack that holds no records is still updated along the way,
  with your choices kept.
- **An install asks about every pack it brings in.** The packs an install
  brought with it were installed at Read only whatever you chose, so a workflow
  writing into one, such as Invoice Book updating Billable Hours, was refused on
  its first run. The dialog now gives each its own Access choice, lists the
  permissions they need (without which Personal CRM could not be installed from
  it at all), and sends the Access level it shows, where "Full access" could be
  silently refused. A marketplace pack now brings in the packs it needs from the
  marketplace, and a refused install names the pack you need to install first.
- **A Records pack whose recipes changed is offered as an update.** It counted
  as up to date on its pack version alone, so an owner who installed Bank
  statement import on 26.9.21 was offered nothing and kept the old import form.
  The Packs page now offers "↑ Update recipes", which goes through the usual
  review.
- **A new link for a customer keeps their agreement.** "Reissue token" and
  "Message customer" issued a new contract stamped from the package template,
  resetting what you had set for that customer: grants and revokes, shared
  packs, command-line tools, their usage cap and their usage so far. The new
  contract now carries the old agreement whole, and a retired template no longer
  blocks a reissue. Moving a customer to another package still resets them to
  it, and says so.
- **Webhook packs install and update from Settings → Packs.** None of the 14
  bundled webhook packs could, because the dialog never asked which webhook each
  binding should use. It now offers the ones that fit, starts at the one in use,
  and links to Connections → Webhooks when none does; an update keeps each
  binding's webhook, and a webhook door you revoked stays revoked through a
  reinstall.
- **A paid quote now reaches paid.** The payment observer listened for a webhook
  no pack declared, so on a real install a paid quote never got there. A new
  pack, Seller Quote Payment Events, declares the Stripe checkout webhook and
  takes over watching for payment; it needs Seller Quote Request 4, and its
  install stops and says so until you have updated that pack from Packs.
- **Every seller order read is fresh.** Seller order reads could be served from
  a cache up to a minute old, so a payment could hit a conflict at its confirm
  step, a fulfilment, renewal, pause, cancellation or tier change could act on a
  stage the order had already left, and the quote board showed a priced order as
  unpriced for a minute. All 43 in the shipped recipes now read fresh.
- **An installed pack's Use tab shows its views and lookups.** Every read on an
  installed pack appeared as an operation button, because the read-only check
  could not read the steps install had rewritten: Rental Book showed eighteen
  buttons, its lists and detail pages among them. It now shows 4 views, 3
  lookups and 11 operations, and over a thousand read-only pack recipes became
  views and lookups. A bookmarked or reloaded detail address now opens its
  record instead of the pack's first view, after a wait that took 5 to 15
  seconds in testing.
- **A time gate reads 7 as Sunday, and three watchers stop failing every tick.**
  Ten recipes' weekday settings say "1=Mon..7=Sun" while the time gate took 0 to
  6, so Personal circle health brief and Unified Work Queue were refused on
  their own defaults and had auto-run switched off; 0 and 7 now both mean
  Sunday. A watcher got an empty value for an input it was not sent, so "Meeting
  alerts before each event" failed every minute and Web Watch & Research's two
  page watchers were refused on every tick. A recipe these switched off stays
  off until you turn it on again.
- **A list setting is saved as a list, and a refusal says what it is.** The
  settings form saved a list as the text typed into it ("slack, email"), which,
  among other things, made the time watcher refuse every window. A refused input
  was reported as a network error, which an automation retried and an AI caller
  read as "come back later"; each kind of refusal, such as a missing record, a
  locked server or a mistyped schedule, now has its own name, and the run dialog
  shows the first error and its step under "Run returned errors". A recipe step
  that schedules a recipe now checks its packs first, so it can no longer arm a
  schedule that fails every time.
- **A run from the webclient is waited for as a run.** It gave up after 30
  seconds, while one AI step alone can take 20 to 40, so runs that finished were
  reported as timed out. The wait is now 5 minutes, and a longer run says it is
  still going on the server, with its result in Logs.
- **A date lands on the day it names.** West of UTC, a date with no time showed
  a day early (Jul 31 for 2026-08-01), and 19 recipes took "today" from the UTC
  clock, so from the evening on it was already tomorrow: bookings were dated a
  day late, and on a month's last evening "last month" meant this month. "Today"
  is now the server's calendar day.
- **A spreadsheet search no longer saves a file every time it runs.** The CSV
  filter step stored its matches as a new file on each run while rated a read;
  it is now rated a write, and a new CSV rows step returns matches without
  saving anything. "Search a spreadsheet like a database" in Excel Workbook Desk
  uses it, and reads a named CSV file under your Files permission, which no CSV
  step could do on a real server.
- **A batch AI step works on OpenAI-compatible models.** A batch returns a JSON
  array, one entry per record, but every structured call asked for JSON mode,
  which on those models returns a single object, so a batch came back with one
  record's answer and failed. Batch calls no longer ask for it; Gemini keeps its
  JSON mode, which accepts arrays.
- **A run that failed after some of its writes landed is asked about, even if
  the first attempt was missed.** The server asks you about those writes, but
  the question was raised on a best-effort basis, so a missed one left the run
  silent. Each start now checks the 200 newest failed runs and asks about any
  that were missed; a run the server crashed in the middle of is still not
  covered.
- **A recipe's Definition shows its steps again, and its card's "→ slack" and
  "reads …" labels are back.** Both broke in 26.9.21, when the recipe list
  stopped carrying step bodies: the Definition showed a recipe with no steps,
  and the labels went missing or undercounted. The detail view now reads the
  whole recipe, and the server sends the labels.
- **The drift and promotion banners come back when they should, and stay
  dismissed when you dismiss them.** Dismissing the drift banner lasted only
  until the next reload; it is now saved on the server and holds until the
  verdict changes. The banner suggesting that a topic run automatically showed
  once, to whoever was looking at that moment; it is now drawn from the stored
  suggestion, and hidden once dismissed or once the topic runs automatically.
- **A pack is no longer refused at install because the machine was busy.** The
  check that refuses request patterns slow enough to hang the process allowed
  each measurement 50 ms, and the slowest shipped pattern took 63 ms under load,
  so a busy machine refused the MongoDB Atlas networking pack outright. The
  limit is now 250 ms, every known catastrophic pattern is still refused, and a
  pattern is now also measured at its field's own maximum length.
- **Descriptions say what an operation does and count what a pack holds.** Forty
  operation descriptions contradicted their own operation (36 Airbyte reads said
  approval was required every run, and never asked), and pack descriptions gave
  the wrong number of built-in actions in 63 packs and of workflows in 36. Every
  count now matches; HubSpot and Salesforce, for instance, now say 7 workflows,
  which is what installing them gives.
- **Approval buttons leave room for the question**, which three buttons used to
  squeeze into a column of single words; the run palette's recipe list shows
  more than one option at a time; Download works on a file that cannot be
  previewed; Kitchen offers its form-response templates again; Retry in
  Settings → Notifications puts focus back on the first switch; a chat message
  the server refuses shows its error beside your draft; a Data → Files search
  typed while a cloud source is loading is no longer dropped; and the Vercel
  sandboxes list reads past its first page.

### Security

- **A new contract keeps exactly what its creator granted.** At each start the
  server gives 17 basic tools, such as mail search, memory write and recipe run,
  to contracts older than the tool gate, and nothing marked a newer contract as
  already handled, so every contract made since the last restart got all 17 at
  the next one: a door made with a short tool list, and a customer package
  template made with none, which every customer issued from it then copied. On
  most doors the token's own tool checklist still applied, so this removed one
  of two guards. It now runs once per server; nothing already granted is taken
  away.
- **A webclient paired to an older server no longer treats every recipe as
  read-only.** Such a server does not say whether a recipe is read-only, so the
  webclient judged from the list row, and since 26.9.21 a row carries no steps,
  so any recipe, a delete or a mail send included, looked read-only and could
  run as a view. A recipe it cannot judge is now a button.
- **An S3 file step can no longer reach the bucket itself.** A path that was
  left out, resolved to nothing, or collapsed to nothing (".", "..", "a/..")
  addressed the bucket instead of a file, so a delete could delete an empty
  bucket and a read returned the bucket's listing as the file; on a path-style
  endpoint such as MinIO, ".." reached the service root. A chat or MCP call that
  left out the path could do this. Reads, writes, deletes and stats now refuse
  such a path before any request goes out; listing, and names with dots inside
  them, are unaffected.
- **Two Ledger book operations that rewrite tags in bulk now ask every run.**
  They were marked destructive but set never to ask, so once the pack was
  granted they ran without a prompt, unlike its eight other destructive
  operations. A check over every shipped operation now catches a destructive one
  that never asks.
- **The `webhook-inventory-planetscale` recipe is withdrawn.** Its whole output
  was PlanetScale webhook signing secrets. Its pack no longer includes it, and
  the marketplace no longer lists it on its own.
- **A sensitive read is an ordinary read: your grant is the permission.** Reads
  tagged sensitive were set to ask for approval, but under every default trust
  ceiling nobody was ever asked, while their descriptions promised otherwise.
  They now run unasked, as they already did, and no description says otherwise;
  the tag stays as a record of what a read returns, and reads that return a
  credential say so. The one change in behaviour: if you set a door's trust
  ceiling to none, you were asked for these reads, and are not any more.

### A note on upgrading

On its first start, this release changes some customers' access, once. The
defect described first under Fixed left every pass sold through the paid-pass
recipes, and every free DeepTutor enrolment, without an end. The first start
gives those passes the end they should have had, on evidence only: a paid order
for that package linked to the customer, or a DeepTutor student record for its
class, and the package unchanged since. A pass whose end has already gone by
ends at that start, never in the past, and your usual grace period (72 hours
unless you have changed it) applies before access stops; a customer who had
access before their pass gets the pass's end, the least they are owed, and is
flagged for you to check.

A missing end date is not proof of the defect — lifetime access can be
deliberate — so a customer with no such trace, or on a package edited since, is
listed and left as they are. You get a notice naming every customer changed and
when their access now stops, and every customer left alone and why, with how to
decide; it links to the package's Re-apply tab, or to the packages list when
they are on several. The repair is recorded together with its changes, so it
runs once, and a failure part-way changes nothing and it tries again at the next
start. The server log says how many passes were given an end and how many were
left for you.

Some approvals you gave on 26.9.21 will be asked for once more: an approval
covers exactly what a step runs, and a built-in step that leaves out an input
now runs something different.

The notice's link needs a webclient from this release, since older webclients
have no Re-apply tab; an older webclient keeps "Give everyone the new package",
which this server still accepts. Paired to an older server, this release's
webclient says to update the server, and treats a recipe as spending whenever
the server cannot say whether it spends.

Every recipe and pack changed since the last marketplace publish carries a new
version — 360 recipes and 747 packs — so the copies you have installed are
offered the change. The 22 bundled packs whose operations are now marked as
billed per call reach a server only through this upgrade: 26.9.21 refuses that
mark, and never reads the published copy of a pack it bundles.

This release adds two database tables and two columns, and rebuilds nothing.
Going back to 26.9.21 afterwards boots and reads your data, with four caveats.
The end dates the repair set stay. A pass sold while reverted comes out without
an end again, because 26.9.21 still has the defect, and the repair does not run
a second time when you upgrade back. An end date set by hand while reverted is
not recorded as set by hand, and that record is what Re-apply reads to tell your
changes from the package's. And a recipe whose update set aside a setting you
had saved refuses every run on 26.9.21 until you clear that setting.

## 26.9.21 — 2026-09-21

Two kinds of work dominate this release. An installed pack stopped being a card
you press and became something you navigate: a row opens where it sits, at an
address you can bookmark and send to someone else, and the apps you actually use
can be pinned where you can reach them. And a measurement pass on what crosses
the connection between your server and your browser found three responses
carrying data nothing on the other end wanted — one of them large enough that
your browser received none of it while the server recorded a success.

### Added

- **A row in a pack's list opens where it is, at its own address.** Pressing a
  row action used to open a form over the list. It now runs in place and gives
  the result a real address, so you can bookmark it, send it to someone, and use
  Back to return to the list you came from. A link is honoured only if the pack
  still offers that view as a read — so a pack update that turns a view into an
  action quietly disarms every link pointing at it, rather than replaying an
  action you did not mean to run.
- **Pick rows, then act on the set.** A list can select several rows and run one
  thing over all of them.
- **Pin the apps you use to the navigation drawer.** A pack's Use tab has a Pin
  control, and pinned apps sit directly under Chats on that device. Unpin
  everything and the drawer is exactly the list it was before — the section
  disappears rather than sitting there empty.
- **A pack's view refreshes when its own data moves**, instead of showing you
  what was true when you opened it.
- **See what changed since you last reviewed.** A saved Records view can show
  the rows that changed since you last said you had looked, and you decide when
  "last looked" is. Nothing new is recorded to make this work; the change log
  was already being kept and simply had no reader.
- **A drift notice is still there when you come back.** A verdict about an
  assistant's confidence drifting used to be shown once, to whoever happened to
  be looking at that moment — a check that ran at 3am was seen by nobody. The
  verdict is stored and the notice is drawn from it, so a reload or a fresh tab
  shows it.
- **A recipe can be fetched by name.** Opening one in the editor used to mean
  downloading every recipe on the server to use one of them.

### Changed

- **Your browser stops downloading things it never reads.** The recipe list no
  longer carries the body of every recipe (10.3 MB to 3.8 MB on a large server,
  and the browser asks for that list many times in a session), the pack list no
  longer carries each pack's full manifest, and opening one recipe in the editor
  now costs about two kilobytes instead of ten megabytes. The two answers that
  genuinely needed a recipe's body are computed on the server and sent along.
- **Confidence drift is decided on how often the assistant declines to answer**,
  which can be stated in a sentence, rather than on the distance between two
  histograms, which cannot. Where that rate is unavailable the older measure is
  still used, but only where it can see.
- **A drift warning now needs enough evidence to mean something.** The sample
  floors were raised after measuring how often the old ones fired on two
  samples drawn from the same distribution — where every warning is false by
  construction. Roughly one in seven was.
- **A stored assistant result is final until the question changes or you say
  otherwise.** It is invalidated by a change to what was asked — the content, or
  the prompt asking about it — or by you. Never by a change in which model
  answered, or in how it has been answering lately.

### Fixed

- **Two storage areas were blocked from writing on every server, from first
  boot.** Creating a schedule could not succeed anywhere — not under load, not on
  a full disk, but on an empty install, always. Each area keeps a reserve, and
  the reserve has a floor; where the floor was larger than the whole allowance,
  the "full" threshold computed to zero bytes and an empty area was already over
  it. The reserve can no longer take more than half of an allowance, so this
  cannot happen to a new area either.
- **The Packs panel could wait forever.** The response was built correctly and
  was too large to send, so the connection was closed and the browser received
  nothing, while the server's own record said the call had succeeded. Attaching
  every pack's manifest to a list was the cost, and it grew with the number of
  packs installed.
- **A reply that cannot be delivered now says so** instead of leaving whoever
  asked waiting for an answer that was already dropped.
- **A list placeholder appeared as literal text in seven recipes.** A reference
  to the current item resolved in one kind of loop and not in another, so the
  characters themselves were written out — and, in one recipe, saved into your
  records as a label and then matched against. A cleanup is included for rows
  that already have those lines, since the pack that wrote them offers no way to
  delete a row.
- **Nineteen row actions were refused the moment you pressed them**, because
  permission was being looked up under the wrong name.
- **A "Run now" button that could never be pressed.** Some maintenance tasks were
  shown with the control permanently disabled, so you could not ask for a fresh
  result even where you had allowed one.
- **A pattern declared by a pack could hang the process.** Packs can describe
  what a field must look like, and that description is run against whatever is
  supplied — including at the door that accepts messages from outside. Only one
  of the three places that did this was checked. All three are bounded now, and
  the check made when a pack is installed takes the field's declared maximum
  length into account, which is the difference between a pattern that is cheap
  and the same pattern that is not.
- **Pin took a reload to appear**, a column the store cannot sort is no longer
  drawn as a sort control, an empty list and a view that cannot be drawn now say
  different things, and a few detail views were named after the pack rather than
  the service they show.

## 26.9.20 — 2026-09-20

This release is mostly about files and about being called correctly. A recipe
result can now draw a picture instead of describing one; a file made only in
order to be emailed no longer has to be kept forever to be sent once; an import
can be told what to do with a row that changed; and an assistant asking to run
one of your operations can finally see what arguments it takes.

### Added

- **A recipe result can show a file, not just name one.** A step that produces an
  image or a document can render it inline in the result, and a run-scoped file
  can be read back for display without copying it into storage first. A preview
  of a photograph you keep on disk no longer means a second copy of it.
- **Mail attachments can be run-scoped.** Attaching a file used to mean storing it
  permanently, because only a stored record could be attached. A temporary file
  made during a run — a resized copy, a rendered document — can now be attached
  directly and is reclaimed when the run ends. Nothing durable is created, so
  there is nothing to clean up afterwards and nothing to accumulate.
  Permanently-stored files attach exactly as before and are never touched.
- **The send's record says what left.** Every attachment on an outgoing message
  is recorded by name, size and content hash, whichever kind it was. Bytes
  crossing the machine boundary should leave a trace of what they were.
- **An import can be told what a changed row means.** Re-importing a list where
  two rows have been corrected used to report two failures and stop, because
  refusing was the only option. It can now refuse, skip, or overwrite, and the
  result counts each separately.
- **Imports can take a file produced earlier in the same run**, rather than only
  text pasted into the request.
- **Local tools report progress without being asked to.** Long-running local
  programs are watched by sampling the work they are doing, so one that has
  genuinely stopped can be told apart from one that is simply slow. Almost no
  tool announces its own progress, so waiting for them to was never going to
  work. It reports; it never kills anything.

### Fixed

- **Operations now tell an assistant what arguments they take.** Thousands of
  operations described their arguments in their own definitions and advertised
  none of them, so a model asked to call one had to guess names that were sitting
  right there. They are published now.
- **A pattern that can hang the process is refused when a pack is installed**,
  rather than when it is first run against unlucky input.
- **A port change that was accepted but never actually applied is surfaced**
  instead of being left to look as though it worked.
- **A retry delay was returned in the wrong unit**, making a short wait a very
  long one.

## 26.9.17 — 2026-09-17

Almost all of this release answers one complaint: a person who installs Recued
at home has to become a network administrator before anything outside the house
can reach them. The server can now ask the router to open its port, the page
that promised to connect a device finally does it, and moving your server to a
new address no longer destroys the pairings you already had.

### Added

- **Recued can ask your router to open its port.** It discovers the router,
  reads what it says it can do, and requests a mapping for the port it is
  actually serving — the step most self-hosters were previously sent off to do
  by hand in a web interface written in the language of firewalls. There is a
  toggle on the setup step that asks for it.
- **The result is measured, not assumed.** After requesting a mapping, Recued
  connects to the port from outside and tells you what happened. A router that
  accepts the request and maps a different port than the one being served is the
  exact failure this exists to catch, and a claim of success would hide it.
- **A hairpin check, run from your own device.** Most reachability tests run on
  the server, which cannot tell you whether *your* laptop on *your* network can
  reach your server through the router. This one runs on the device reading the
  page. Its verdict expires after five minutes and belongs to the network it was
  earned on, because a verdict that follows you to a different network is worse
  than none.
- **Use limits can refill.** A limit on how many times something may run can now
  reset daily, monthly, or never. It refuses at the boundary rather than quietly
  trimming the request to fit, so you find out.
- **A screen-scale setting** for displays that render Recued too small or too
  large.

### Security

- **Router discovery is treated as an untrusted input.** Discovery works by
  shouting on the local network and using the reply to decide what to fetch
  next, which means whatever answers gets a say in where Recued sends requests.
  Those requests are now confined to a genuine private address belonging to the
  device that answered, so a host on your network cannot use a discovery reply
  to point Recued at something else.

### Fixed

- **Moving your server to a new address destroyed every paired browser.** The
  stored token was sealed against the server's URL, so changing that URL made
  every later use of the token fail to open — by the feature whose whole purpose
  was to let the address change. Tokens are now sealed without the address and
  re-sealed as they are used. If you have been putting off moving your server,
  this is the release that makes it safe.
- **Notifications sent to the app itself reached nobody.** The in-app channel
  published an event that no client was listening for. Sends were recorded as
  delivered and then dropped on the way out, so the logs said the notification
  had gone out while nothing ever appeared — and one shipped recipe used that
  channel by default.
- **A server that was no longer yours kept asking anyway.** When an account was
  unbound, deleted, or bound to a different server, the old server carried on
  checking for a subscription that was never coming back — roughly 288 rejected
  requests a day — and told its owner nothing. It now says so once and stops.
- **Recued could email you a link to an address nothing can reach.** The check
  that decides whether your server is reachable from the internet treated a
  carrier-NAT address as public, so the one-click answer link went out pointing
  somewhere no incoming connection could arrive. A local `.local` name written
  with a trailing dot — the form the URL parser actually produces — was not
  recognised either.
- **Two screens could refresh each other indefinitely.** Reading a board is not
  a reason to re-read it.

### Improved

- **"Connect a device" now connects the device.** The page walked you through
  diagnosing your network and then left you to find the pairing screen somewhere
  else. The diagnosis panel is gone, its three separate check buttons are one
  action, and the finding about exposing your server on the local network moved
  to the page about exposure, where someone looking for it would think to look.
- **Every surface that completes a task now takes the same lock,** so finishing
  the same task from two places at once cannot produce two outcomes.

### A note on upgrading

This release adds one database table, for the router port mappings it now keeps
track of. It adds no columns and rebuilds nothing, so going back to 26.9.15
afterwards is safe: the older version neither reads nor writes that table.

## 26.9.15 — 2026-09-15

Mostly the marketplace packs and the checks that are supposed to keep them
honest — one of which had quietly stopped working. Plus the page explaining how
to reach your server from a second device, rewritten for the person doing it,
and a `doctor` command for when the server will not start.

### Security

- **An OpenAI pack exposed an operation that hands back a newly created API
  key.** `openai-organization-access` included the call that mints a service
  account's API key and returns it in the response body. It was meant to be
  excluded, and the exclusion had silently stopped matching: OpenAI now derives
  that operation's identifier from its summary text, so the name the exclusion
  looked for no longer existed anywhere and the operation shipped with the pack.
  Every one of the 161 lists that name operations this way is now checked, so a
  renamed operation is refused rather than ignored. If you have that pack
  installed, update.
- **The same check now covers lists that do not announce their own failure.**
  The earlier version only guarded lists marked as safety-critical, on the
  reasoning that the rest would break loudly if they went stale. That was wrong
  for the largest group it left out: a stale pagination entry does not break the
  call, it stops reading after the first page and the caller believes that is
  everything.

### Added

- **`recued doctor`** — a diagnosis that still works when the server is down.
  Installing Recued is a terminal task by design, so a shell is the one thing a
  stuck self-hoster reliably has. The individual checks already existed; nothing
  gathered them into one answer.
- **Grouped tables.** A recipe can group a table's rows by a field, and the
  surface showing it decides how that looks.

### Fixed

- **Deleting a connection could leave its data behind.** When the cleanup of
  mirrored data failed, the connection record was deleted anyway — so the data
  it named stayed on disk with nothing left pointing at it.
- **Work you had pre-approved, then missed during an outage, appeared nowhere.**
  An approved run that expired left no trace at all.
- **Recued could put an approval on a channel that cannot reach you.** Being
  approved means being asked without prompting first, so a channel that can only
  answer when you speak to it cannot carry one.
- **Every pack operation that runs a command line now declares the arguments it
  accepts** — all 450 of them. An argument that is not declared is not passed.
- **A pack that could not be proved is treated as a defect rather than a gap.**
  One pack was withdrawn instead of shipping unproved.

### Improved

- **"Use Recued on another device" is written for the person doing it.** It was
  organised around ports, which is the right shape for an operator and the wrong
  one for someone who just wants their phone to work. It now follows the three
  situations people actually ask about — this computer, at home, away — and the
  free routes to a certificate (Tailscale, Caddy, or bring your own) are steps
  you can follow rather than a phrase to go look up.

### A note on upgrading

This release changes no database schema — no new tables, no new columns, nothing
rebuilt. Going back to 26.9.14 afterwards is safe, with none of the caveats the
last release carried.

## 26.9.14 — 2026-09-14

Three threads that turn out to answer the same complaint from different sides:
the assistant could read your world but never add to it, reminders you set here
never actually reached you, and the screens that explain both were written for
the people who built them.

### Added

- **The assistant can put things in, not just read them back.** It can create a
  task, a commitment or a booking, and mark one done, reschedule it or rename
  it. Until now it could only tell you what was already there.
- **It can add to your calendar — and it stops to ask first.** Creating or
  changing a calendar event is the first thing the assistant does that
  deliberately pauses for your approval instead of acting.
- **Attach files from the cloud accounts you have connected**, not only from
  the device in front of you. Where a file came from is remembered, an
  attachment survives a retry, and previews are shared between your files and
  your chats. Deleting a file no longer takes a conversation's copy with it.
- **Choose what you are notified about, and how far ahead.** Tasks,
  commitments, bookings and calendar events each carry their own setting, so
  you can ask for a day's warning on one and an hour on another — or turn one
  off entirely.
- **Quiet hours.** One window and one switch: nothing reaches you inside it,
  and you get a summary of what happened when it ends. Approvals can be let
  through if you would rather be interrupted for those.

### Fixed

- **Reminders you set in Recued never reached you.** A task or commitment with
  a deadline you typed here told nobody. The deadline was recorded and the
  settings screen offered controls over it, but there was nothing on the other
  end. All four kinds now notify you, and a restart no longer makes Recued tell
  you the same thing twice.
- **The setting for how far ahead you are warned could not be opened.** The
  behaviour shipped and worked; nothing in the interface could change it, so it
  quietly stayed at its default for everyone. A setting you cannot reach is the
  same as no setting.
- **A missed schedule now says which one is waiting and how late it is**,
  rather than only that something was missed.
- **An unattended automation that fails now says so and stops**, instead of
  failing on a timer indefinitely.

### Improved

- **Quiet hours runs on a clock your server declares, rather than one it
  guesses.** A window like 22:00 to 07:00 means nothing without a zone, and a
  laptop crossing an ocean should not move it. You set the zone once; the panel
  previews both clocks with their dates and links you to where it is changed.
- **Plain English across more of the interface** — the recipe editor,
  connection setup, and a good deal of jargon an earlier pass walked straight
  past.
- **A board is created by the first submission that declares it**, whoever
  wrote the recipe owns its tag, and the description stays editable after it is
  first published.
- **Work you create leaves a trail you can follow**, and the calendar Recued
  keeps for you now says whose it is by name.

### A note on upgrading

This release adds tables and columns, and rebuilds one of them. The upgrade is
unattended and copies every row forward. Going back to 26.9.10 still works,
with one caveat: a board published from a recipe — new in this release — stores
something the older version's schema does not expect. If you think you may want
to revert, do it before publishing a board that way.

## 26.9.10 — 2026-09-10

Three things this time. Recued now keeps a short running summary of what a
conversation is about, and — this is the part that was missing — you can read it
and clear it. Automations you trust can be approved once instead of asking you
every time. And you can answer an approval out loud.

### Added

- **You can see what Recued is carrying in a conversation.** It keeps a short
  running summary so it does not lose the thread over a long chat. Until now that
  summary was invisible and disappeared whenever the server restarted. It is now
  saved, encrypted, survives a restart, and is shown in the chat — and there is a
  button to clear it if it has picked up something you would rather it forgot.
  It is on by default, and one setting controls it.
- **Approve an automation once, instead of every time.** If you trust a
  particular automation to do a particular thing, you can say so up front, with
  your own limits on it. Recued still asks about anything outside what you
  allowed. It also warns you if two automations are about to do the same thing,
  rather than quietly doing it twice.
- **Answer an approval by voice.** You can deny something by speaking. Approving
  still needs a tap — saying yes by accident should be harder than saying no.

### Fixed

- **A daily limit could switch itself off permanently.** Once it had been hit,
  the only thing that would have reset it was the request it was refusing, so it
  stayed stuck. It now resets on time.
- **Long conversations are summarised more carefully.** What you actually typed
  is always kept; only Recued's own notes get compressed. If a summary cannot be
  made shorter it is skipped rather than run for nothing, and if it fails near the
  end of a reply the reply stops and says so instead of quietly continuing with
  less than it should have.
- **A restart shows what was running.** Work that was in progress is no longer
  invisible afterwards.
- **A round of background work where every item failed no longer reports
  success.**

### Improved

- **Recued checks once whether AI is available at the start of a background
  round**, instead of rediscovering it item by item.

## 26.9.5 — 2026-09-05

You can now sell through Paddle and Lemon Squeezy, not just Stripe. The other
half of this release is about Recued's memory in a conversation: it was throwing
away the results of its own tools and then, a few messages later, redoing the
work or quietly making something up instead. It now keeps them, and knows they
are there.

### Added

- **Paddle and Lemon Squeezy as payment providers.** Subscriptions, one-time
  passes, refunds, and the customer lifecycle, alongside the Stripe support that
  already existed. Your product catalogue seeds the tiers, so you set prices
  where you already set them. Settings → Seller is now a set of separate pages
  rather than one long form, and each one has its own address you can link to.
- **Writing an email with Recued's help.** Ask it to rewrite a draft and it
  changes the body only, never the recipients or the subject, with an undo that
  is safe even if you have kept typing. Drafts survive a send that fails, and
  Recued tells you up front if no mailbox is set up to send at all.
- **Your server tells you when an update finished** — and when it recovered
  itself after a bad one, rather than leaving you to notice.

### Fixed

- **Recued stops forgetting what its own tools just told it.** Results from
  tools it ran were not being kept, so a few messages later it could not look
  back at them. In testing it would re-send a message with different wording
  while its own notes said "same as before". Results are kept now, tied to the
  request that produced them, and Recued is told they are available.
- **Long conversations are trimmed sensibly.** Recued was deciding what to drop
  without actually knowing how much the model could accept — it now learns each
  model's limit. If it cannot trim enough to fit, it says so and stops instead of
  sending something that will fail, and when it refuses it tells you what you can
  change.
- **Search returns fewer irrelevant things.** A word that appears in almost
  everything was pulling in almost everything; those words are now ignored rather
  than everything being cut off at an arbitrary number.
- **A pack that can no longer run tells you at startup**, with a link straight to
  it, instead of only writing a line in the log.

### Improved

- **The documentation is rewritten.** All 36 pages, in plain English, and
  organised around the address you actually use. Two install methods that were
  described but did not exist yet — a container image and one-click VPS setup —
  have been removed until they do; a documented path that is not there is worse
  than no documentation, because you only find out at the point of trying it.

## 26.9.3 — 2026-09-03

Recued can now stop a job it started for you. Ask it to run something, change
your mind, and say "do this instead" — until now the new thing started and the
old one kept going, so "instead" quietly became "as well". Alongside that: if
you started your server the way the setup instructions tell you to, there was no
supported way to upgrade it. That is fixed, and so is a search that was getting
worse the longer you talked to it.

### Fixed

- **`recued stop` can stop the server Recued actually starts.** A server run with
  `recued serve` — what the startup banner prints, and what start-at-login uses
  on both Linux and macOS — left no process file behind, so `recued stop` could
  not see it. That closed a circle: the installer refuses to upgrade a working
  install and points at `recued update apply`; `apply` refuses while a server is
  running and points at stopping it; `stop` could not stop it. If you had no
  browser tab paired, there was no way through. `stop` now finds the running
  server the same way the updater already did, and tells you if start-at-login
  will bring it back.
- **`recued status` answers about your server, not about a port.** It asked
  whether *anything* was answering on the port it was given, so a second server
  on the same port looked like yours, and your own server could be missed if it
  had bound a different one.
- **Search stopped requiring every word.** Asking Recued to recall something
  only matched when *every* word in your question appeared in the same record —
  so the more you said, the less it found. On a fixed set of records where two of
  the words always matched, five-word questions found nothing at all. Longer,
  more natural questions now work rather than working against you.
- **Chat setup steps and a messaging gap** left over from the previous release.

### Added

- **"Stop that" works.** Recued can end a run it started, so redirecting it
  mid-task no longer leaves the first job running against your accounts.
- **A startup warning when an installed pack can no longer run.** Some older
  packs declared their command-line steps in a form Recued no longer accepts.
  Nothing looked wrong at startup and the first sign was a step failing at the
  moment you wanted it — your server now tells you at boot, and names the pack,
  instead of leaving you to find out.

### Improved

- **A step with no time limit can no longer also be unwatched.** Removing the
  deadline from a long-running command left nothing able to notice it had hung —
  it would simply run until you spotted it and stopped it by hand. A step without
  a deadline must now report progress, so a stall is detected either way.
- **Release publishing** verifies its own bookkeeping more carefully: a
  successful publish no longer leaves its internal lock held, and the check that
  compares the published source against this one no longer trips over which
  machine built it.

## 26.9.2 — 2026-09-02

This release is about what happens when an update is interrupted. Power loss, a
reboot, a closed terminal — anything that stops a server halfway through
replacing itself. Previously some of those moments could leave a machine that
would not start, with the version it came from already consumed. That is now a
transaction: the next start either finishes the swap or undoes it, before
anything else loads. Updating on Windows got most of the attention it was owed,
and updates no longer expire.

### Fixed

- **An interrupted update leaves a server that still starts.** Replacing the
  program means moving two files that have to match — the executable and the
  database engine it was built against. If the machine died between them, you
  were left with a mismatched pair that boots, looks healthy, and fails the
  moment it opens your data, with nothing to go back to. Both halves now move
  as one step, and a server that finds a half-finished swap completes or
  reverses it before it loads anything.
- **`recued update rollback` works on Windows.** It looked for the previous
  version under a filename without `.exe`, so it reported "no previous binary"
  and left the new one running — on the one platform that has no service manager
  to fall back on. Rolling back from a stopped server also no longer depends on
  the component that may be why you are rolling back.
- **Rolling back the server rolls back the app with it.** An update replaced the
  bundled web app and removed the backup as soon as the new one landed, so a
  rollback put an older server behind a newer interface — a pairing neither half
  expects.
- **Updates stop expiring.** A release feed carried a freshness date, and past it
  your server stopped being offered updates and the installer refused to install
  at all, even though the release was signed, current, and the newest one
  available. A feed that has simply not changed and a feed someone is holding
  still look identical from the outside, and the only response available was to
  refuse the newest release anyone has. Downgrades are still refused, which was
  always the part doing the work.
- **Installing on Windows with `-Channel edge` failed outright**, and a re-install
  could put an older version over a newer one. The Windows installer now resolves
  a channel the same way every other part of Recued does, refuses a downgrade,
  and applies the same manifest checks the Linux and macOS installer has had:
  it will not accept a replayed feed, a manifest from a newer format it cannot
  read, or bytes that do not match what was signed.
- **A failed install no longer destroys the install you had.** An upgrade that
  failed partway could leave you with neither version.
- **Running two servers on one machine no longer confuses an update.** Update
  state was tracked per database rather than per machine, so a second server
  could act during the first one's update, and a feed one had already refused as
  a replay could still be accepted by the other.
- **If you run Recued from source, an update from the web interface could
  overwrite the program you launched it with.** It now refuses instead.
- **Settings → Updates asks about the release you actually read about.** If a
  newer one is published while the page is open, it tells you and asks again
  rather than installing something you did not agree to. Applying an update
  reports progress and its real outcome, and a reply lost to the restart is
  recovered rather than leaving the page guessing. On Windows, where start-at-
  login is not a service manager, the page now says so before downloading
  anything instead of stranding a stopped daemon.

### Added

- **A server that cannot start at all is put back automatically.** Until now the
  safety net counted failures inside the server, which cannot help if the new
  version never runs — a truncated download, the wrong architecture, a missing
  system library. Installing now also writes a small supervisor that sits
  outside the program, is never replaced by an update, and hands the decision to
  the previous version, which is known to work because restoring it is the whole
  point.
- **A snapshot before an update that changes the database.** The first start on
  a release that migrates your data now records the state it came from, so a
  rollback can restore the data as well as the program. If there is no snapshot
  to restore, the rollback is refused rather than performed halfway.
- **Same-day fixes.** Versions are dates, which allowed one release per day. An
  urgent fix can now ship as a fourth number — 26.9.2.1 — on the same day as the
  release it repairs.

### Improved

- **What a release proves about itself before it is published.** Every
  downloadable file is now checked to be a real executable of the right shape for
  the platform it claims, to carry the exact version the release is labelled
  with, and to have been run and exercised on the machine that built it. Docker
  images are verified on both architectures rather than only the one doing the
  publishing, and a release is signed against the source it was built from.

## 26.8.31 — 2026-08-31

The update button stops telling you it failed when it did not. Applying an
update from Settings → Updates reported a failure on every real update, because
the request timed out in the browser after 30 seconds while the server carried
on downloading and finished the job perfectly well. The outcome was right and
the message was wrong, which is a bad combination — you were likely to retry a
144 MB download, or give up on a server that had already updated itself.

### Fixed

- **The in-app update reports what actually happened.** The server now accepts
  the request immediately and reports progress and the outcome as it goes,
  rather than making the browser wait for the whole download. If your server is
  older than this release, the page still handles it the old way — and it no
  longer gives up after 30 seconds, so the false failure is gone either way.
- **One database location, instead of wherever you were standing.** The default
  was relative to your current directory, so running the server from two
  different folders quietly created two different servers. On a real machine
  this produced three separate installs in twenty-five minutes. There is one
  standard path now, and an ambiguous case is refused rather than guessed.
- **`recued status` and `recued stop` no longer say "not running" about a
  running server.** They read a file that only exists when the server was
  started in the background, so a server started in the foreground — which is
  what the setup instructions tell you to do — looked stopped to both.
- **Start-at-login on a headless Linux server.** Running as root now installs a
  boot service rather than a login-session one, and the credential store refuses
  to seal a server's keys to a login session that will not survive a reboot.
- **A weighted-forecast figure that was 100 times too small.** Three HubSpot
  recipes divided a probability by 100 when it was already a fraction — an
  812,700 pipeline reported as 5,836.

### Improved

- The build now checks that the packaged database engine matches the runtime it
  ships with, instead of only checking that it is present. A mismatch produces
  the worst kind of build: it starts, looks healthy, and fails the moment it
  opens your data.

## 26.8.30 — 2026-08-30

Mostly things that existed and did nothing. The public metric boards had no
boards in them, so every submission was rejected. The publisher handle you need
to appear on one was charged for in code and free in the pricing — which made
publishing a Pro feature by accident. Both are fixed, and the boards are live.

### Fixed

- **The metric boards accept entries now.** The surface was built and deployed
  with nothing behind it: no boards existed, so every server that submitted was
  turned away. Six are live — autopilot, economy, toolmaker, waved through,
  burst, throughput.
- **A publisher handle is free, as the pricing has always said.** Reserving,
  changing or transferring one returned "Pro subscription required". Since a
  board entry needs a handle, that quietly made publishing Pro-only. Pro still
  buys what it always bought: the DDNS subdomain and the certificate.
- **Uninstall now tells you to stop the server first.** Since the installer
  started running your server for you at install time, removing the files
  without stopping it left your system trying to restart a program that was no
  longer there. The instructions name the right command for how your machine
  actually starts it — which is not the same command on every platform.
- **Smaller reporting honesty fixes on the boards**: a rank of zero is not a
  rank, "1 participants" is not a count, a rejected entry is no longer counted
  as a successful one, and "send now" says what it did rather than promising a
  schedule.

### Improved

- **Searching across connected services fans out by default.** Ask for
  something and it looks everywhere it can; naming a connection narrows *where*
  it looks, and a filter narrows *what* it looks for. Where a general tool
  already searched more widely than a service-specific one, the narrower
  duplicate was removed rather than left to shadow it.

## 26.8.29 — 2026-08-29

If you installed Recued from a released binary, updates have never actually
completed. The update downloaded, verified, and swapped correctly — and then
the server, on booting the new version, could not recognise it as the one it
had just staged. It counted each healthy start as a failed one and rolled you
back to the previous version on the third restart. Every fix we have shipped
since the update system landed could be applied and could not stick. This is
the first release that can deliver itself.

Two other things that had never worked are fixed with it: `recued start`, and —
on Windows — start-at-login, which is built on `recued start`.

### Fixed

- **Updates now stick.** The server read its own version through a build-time
  constant that was never substituted, so it reported itself as `unknown`,
  never matched the release it had staged, and treated every successful boot as
  a failed one. If you applied 26.8.28 and later found yourself back on
  26.8.27, that is why. Nothing was at risk — the fallback was the previous
  working version — but the fix could not reach you.
- **`recued start` works.** In a released binary it launched the server the way
  a development checkout does, by handing a source file to a toolchain that
  only exists in one; on a machine that installed the binary there is nothing
  there to run it. It reported success and `recued status` then said `stopped`,
  truthfully.
- **Start-at-login on Windows.** It is built on `recued start`, so it had never
  worked either. macOS and Linux were unaffected — they run the server directly.
- **Opening a result from search did nothing.** No navigation and no error.

### Added

- **Search your own data without asking the AI.** One query across mail,
  calendar, files and webhooks, grouped by where each result came from rather
  than blended into one ranked list. It also finds installed packs and the
  capabilities inside them. Recued's premise is that the AI is optional, and
  until now searching your own warehouse was the one thing that required it.
- **Ask how Recued itself works.** The assistant can now answer setup and
  concept questions from the documentation the server ships, instead of
  guessing. Recued is not public, so a model has no prior knowledge of it — and
  an invented menu path reads exactly like a real one.
- **A simpler first run.** On a new install the server now starts under your
  system's own supervisor immediately, and setup is:

  ```
  recued pair      # prints a pairing code and a link
  ```

  Previously you ran a server in a terminal, paired, and were left to work out
  how to hand it over to the thing that starts it at login. If you install with
  start-at-login turned off (`RECUED_AUTOSTART=0`), nothing changes for you —
  there is no supervisor to hand off to, so running it yourself is still the
  whole story.

### Improved

- **Dates you write in your own words are no longer rejected.** Writing
  "14 October 2026" and having the assistant use `2026-10-14` was treated as an
  invented value, with advice to run a step that did not exist because the date
  came from you.

## 26.8.28 — 2026-08-28

`recued start` — the command the installer prints as the way to run in the
background — has never worked in a released binary. It reported that it had
started, and `recued status` then said `stopped`, truthfully: the process it
launched was already dead. This is the same shape as the three faults 26.8.27
fixed, and it survived for the same reason. The daemon launched the server the
way a source checkout does, by handing a TypeScript file to a toolchain that
only exists in a development tree; on a machine that installed the binary,
there is nothing there to run it.

Running from source was never affected, and neither was start-at-login — the
macOS and Linux service units run the server in the foreground, so a machine
set up by the installer has been starting correctly all along. If you hit this,
`recued serve` was the way through it.

This release also stops the class from shipping again: the publish now boots
the actual artifact, opens it in a real browser, and pairs to it — through both
`recued serve` and `recued start` — before anything is signed.

### Fixed

- **`recued start` could not start anything.** The packaged binary now
  re-executes itself to run in the background, and lands in your realm's
  directory rather than wherever the command was typed — a restart could
  otherwise have opened a different database.
- **A failure reaching your own server is no longer blamed on the browser.**
  26.8.27 taught Recued to recognise a connection the browser itself refuses;
  the test it used was also true for `127.0.0.1`, which browsers permit, so
  local failures were attributed to the wrong cause and the real one went
  unreported.
- **Search results in a conversation could not be put back in order.** Results
  come back by relevance, which is right for retrieval, but they carried no
  date — so a negotiation arrived scrambled, and in a negotiation the order is
  the meaning: the refusal that provoked a counter-offer reads as terms if you
  cannot see that it came first.
- **Neighbouring messages followed one side of a conversation, not both.** The
  walk was scoped to whoever sent the message you started from, though it was
  described as following the correspondents. Anchored on their message it
  missed your own out-of-thread reply; anchored on yours it pulled in unrelated
  mail you had sent to other people. It follows the pair now.
- **A file search that found nothing now says why.** When several search terms
  match different files but no single file matches them all, the result reports
  that instead of a flat "nothing found" — which was hiding files that were
  plainly relevant.
- **Scores no longer disagree with their own breakdown.** An overall score
  defined as the average of its criteria was being written before the criteria
  were, so the model had to make the terms agree with a number it had already
  committed to.

### Improved

- **The model gets somewhere to work before it answers.** Responses are
  structured so reasoning is written before the answer rather than after it,
  which matters for questions whose answer is derived rather than stated — a
  price that only follows from a discount and a quantity mentioned several
  messages apart.
- **Setup steps stop disappearing after your first chat.** The cards for
  connecting an account and adding a model described exactly what you had not
  done yet, and retired themselves the moment any conversation had a message.

### A note on Chrome 149 and local servers

Chrome now asks permission before a page on a public site may reach a server on
your own machine, `127.0.0.1` included. Pairing the hosted webclient at
`app.recued.com` to a server on your desktop needs that permission granted; if
it is denied, the request fails before it leaves the browser and the pairing
screen can only report that it could not reach the server. This is the browser
asking, not Recued — a server on the same machine you are browsing from is
exactly the case the permission exists for.

## 26.8.27 — 2026-08-27

If you installed Recued from a released binary, it could not be paired to — at
all, since the binary channel opened on 31 July. It booted, printed a pairing
code, served its health endpoint and the webclient, and then silently dropped
every WebSocket connection. It also could not update itself out of that state,
and it never installed the webclient in the first place. Three separate causes,
all of them living only in the packaged binary and none visible to a test suite
that runs from source. This release fixes all three, and adds the build gates
that would have caught each one.

Running from source was never affected.

### Fixed

- **Released binaries had no WebSocket server.** The socket library was loaded
  in a way the bundler could not see, so it was never packaged; at runtime the
  server fell back to a stub that closed every connection without a reply. A
  closed connection with no reply is indistinguishable from an unreachable
  machine, which is why it presented as "can't reach your server" about a
  server that was running fine.
- **Updates could never download.** The updater's size limit was smaller than
  every binary published — three of four platforms refused their own release
  before a byte was transferred. Both the in-app update and the CLI were
  affected.
- **The installer never fetched the webclient.** `/webclient` returned 404 on
  every fresh install, on every platform, while a server that self-updated
  acquired one — so it appeared only after an update, never after an install.
- **A socket your browser refuses now says so.** Opening an insecure `ws://`
  connection from a secure page fails identically to an unreachable host, so
  every surface blamed the server. Recued now recognises the browser's own
  refusal and tells you what to do about it.
- **Pairing.** A restarted server offered `Pairing code: null` with no way to
  mint another; the banner claimed 15 minutes for a code that lives a week;
  `recued pair` could not list the loopback address you are most likely to use;
  and a connection failure mid-pair left the screen spinning instead of
  reporting.
- **Mail search results now show the part that answers the question.** The
  indexed text led with the from/to/cc addresses, and a search snippet is a
  fixed-size window of words around the match — one address alone is four
  words, so the window frequently closed just before the sentence you were
  looking for. Subject and body come first now. What matches and how results
  rank are unchanged; only what you are shown moved. Your mail index rebuilds
  itself once on the first start after updating.
- **A fresh server no longer probes DNS for a provider it does not have**, and
  several hostname and certificate paths stopped referring to a zone that had
  moved.
- **Search in your own languages.** Message indexing corrupted non-English
  input and was inert for five scripts; unspaced scripts (Chinese, Japanese,
  Korean and others) now get a real index. `file.search` was listed as
  available and returned nothing on every turn, then matched only a bare
  filename as a single literal phrase; it now matches name and path and reaches
  declared remote sources.

### Added

- **`recued update apply` and `recued update rollback`**, for a stopped server.
  The in-app updater runs over the WebSocket, so a fault in that layer takes
  the updater with it — as one did. The CLI refuses while a server is running
  and points at the surface that can restart itself, and it verifies signatures
  exactly as the server does, keeping the previous binary for rollback.
- **Start at login, on by default** on macOS, Linux and Windows — opt out with
  `RECUED_AUTOSTART=0`. Without it the server stops when its terminal closes
  and an update cannot restart it for you. It gives you a supervised server,
  not necessarily an unattended one: a passphrase-sealed keyfile still waits
  for `recued unlock`. Headless Linux needs root for a boot unit.
- **Install documentation in this repository.** The README and INSTALL.md now
  cover installing a release and every option, instead of sending you to build
  from a clone.

### Changed

- **Re-running the installer over a running server now tells you it is still on
  the old binary.** Replacing a file does not change a process already running,
  and nothing here restarts it — so it prints the command your server is
  actually running rather than a generic one that could point it at a different
  database.

## 26.8.26 — 2026-08-26

Mostly about what the AI can find. A chat turn now starts with an index of what
your own stores actually contain, so the model asks for things that exist
instead of guessing at names — and when an answer is truncated, the record that
CORRECTS a fact is no longer the one that falls off the end. Alongside that,
the first numbers Recued keeps about itself, and they are yours before they are
anyone's.

### Added

- **A pre-seed index of your own data, on by default.** Each turn opens with a
  generated index over the read stores the model can reach, ranked by which
  terms actually discriminate between your records rather than by a generic
  word list. It declares its own partiality — an index that quietly omits
  things teaches the model to trust it exactly where it should not. Disable
  with `RECUED_CHAT_INDEX=0`.
- **Relative navigation.** Mail and recall take `near_id` with next/prev, so
  "the message just before that one" is a lookup rather than a re-search.
- **Thread neighbours, to reach the answer that matches nothing.** The reply
  that corrects a fact rarely repeats its wording — "actually Ridgeway is 90
  days" contains neither "renewal" nor "notice". Search now reaches along the
  thread to find it, and labels partial matches instead of hiding them.
- **Your own numbers.** A `#stats` surface and a `metric.read` rpc over the
  pair connection show what your server has been doing. Publishing any of it is
  a separate, bounded, revocable grant, and the publish dialog shows the
  complete payload before a byte of it leaves.
- **A global Run palette** in the webclient, plus consistent hierarchical
  navigation and continuity when previewing lists.
- **macOS builds enter the release chain.** Both triples are built, signed with
  a Developer ID and boot-tested before staging.

### Changed

- **A correction must survive truncation.** Results carry a recency floor, so
  trimming a long result set can no longer drop the newest record — the one
  most likely to be the correction — and the model is told when truncation
  happened rather than being handed a short list that looks complete.
- **Empty results relax over terms the index actually holds** instead of
  returning nothing and letting the model conclude the data is absent.
- **A turn that answers without looking earns one guided retry**, and the
  absence detector now recognises "I don't have a stored preference" as the
  claim it is.

### Fixed

- **A peer could forge an answer verdict.** The check was a substring match
  over text a peer supplied, so peer-controlled content could satisfy it.
- **`near_id` was rejected by the argument allow-list**, so relative navigation
  dispatched nothing at all — the feature was present and unreachable.
- **The admin dashboard's stats query could not succeed against any database.**
- **Thread follow-up was undiscoverable**, and the list path returned no bodies.
- **The installer picked the wrong macOS build from a translated shell.** On
  Apple Silicon `uname -m` reports the shell, not the machine, so running the
  installer under Rosetta fetched the x64 binary — which works, slower, on a
  translation layer Apple is winding down. It now detects that and installs the
  arm64 build, saying so.

## 26.8.24 — 2026-08-24

Meetings are the theme. A meeting can now be prepared from what your projects
already know, and what you type afterwards becomes work rather than a note you
will not reread. Alongside that, two things that had been quietly wrong for a
while: approvals arrived with no sense of which were urgent, and nothing
anywhere told you what an AI call had cost.

### Added

- **A meeting can be prepared from your own project context, and its outcome
  becomes work.** Recued reads what your projects know before the meeting, and
  turns what you write afterwards into the tasks and records that follow from
  it. Cal.com bookings drive it end to end, including meetings Recued's
  calendar never saw — an ad-hoc conversation gets the same preparation as a
  booked one.
- **Every provider call reports what it spent.** A run's audit entry now
  carries the usage it accumulated, housekeeping reports spend per task, and
  the LLM gateway accounts for what it consumed on a caller's behalf. A synced
  plan can state a limit at all, and one without a limit says so instead of
  showing a blank.
- **The approval queue behaves like a queue.** Oldest first, how long each has
  been waiting, and when one expires. A notification names the recipe behind
  it, so an ask is identifiable before you open it. An automation you trust can
  be told yes once and keep that answer.
- **`recued pair` works.** The pairing code is shared between processes now, so
  the code the CLI prints is the code the server will accept — previously each
  process minted its own and the printed one was refused.
- **The Browser Bridge has a Chrome Web Store submission bundle**, with
  `/bridge` and its terms published on the site.

### Changed

- **A recipe that only notifies you no longer asks permission first.** Being
  told something is not an action on your behalf, and treating it as one taught
  people to approve without reading.
- **Tool search returns every match.** The 5- and 20-result caps are gone; a
  model asking what it can do now sees the whole answer rather than a
  truncation it cannot detect.
- **The install now states the server's timezone** and how to change it —
  schedules are interpreted in it, so it should not be something you infer.
- **The step-context ceiling rises from 10 MB to 50 MB**, sized from the
  constant its tests read rather than a number repeated in both places.
- **`user_entitlements` is retired.** It only ever reported `free` — including
  to a paying account — so every reader was better served by the source it
  should have consulted.

### Fixed

- **An address sent to an AI leaked its postcode.** Aliasing replaced parts of
  an address individually, so the pieces that survived were enough to locate
  it. A whole address is now aliased as one unit that carries only its region.
  Known contacts are aliased in tool results too, not only when the turn
  surfaced them directly, and Cal.com attendee details are protected before
  they reach a model.
- **Peer-to-peer was dead on the main branch** — ten defects, none of which any
  test was red for. A colleague can now join a shared project before their own
  server is ready, and reading your own day no longer routes through a peer's
  door to fetch what is already local.
- **A run held for approval reported itself as failed.** It is waiting, and now
  says so.
- **One unpreparable booking starved every booking behind it**, so a single bad
  record stopped the queue rather than being skipped.
- **A meeting transcript never reached the model** it was gathered for.
- **The grounding gate accepted its own refusal as evidence** and rejected two
  values a model could legitimately hold, including a phone number written the
  way a person writes one.
- **Windows installs were uncounted** because the installer sent no User-Agent,
  and the "Total installs" figure counted marketplace content rather than
  servers.
- **Autostart could promise a start it would then withhold.** It now refuses an
  unconfigured realm outright and the installer tells you to pair first.

## 26.8.19 — 2026-08-19

Housekeeping, mostly, and the honest kind: several things this distribution was
telling you were either internal noise or quietly wrong.

Seven built-in recipes were displaying an internal tracking tag in their names —
"Today (D-145 PA10)" and friends. That tag was in the marketplace listing, the
recipe list, and the tool catalog the assistant reads. It is gone. Existing
installs keep the old label until the recipe is reinstalled, because the packs
that ship these pin them by version and bumping that would strand every
reference; new installs are clean.

The public source no longer carries the operator's own environment. The cloud
apex used to be a constant in this source with a runtime hostname check to swap
onto a mirror — a branch nobody running their own server can take, naming a
domain nobody running their own server can reach. It is configuration now
(`RECUED_CLOUD_APEX`, and a build define for the webclient), so what you read is
the deployment you actually get. A handful of comments that described the old
behaviour were corrected along with it.

Recipe grants finished landing. The access axis added in 26.8.18 now has its
remaining pieces: the seeding rule is pinned at both ends, chat applies the same
recipe-preferred suppression the MCP door always has, and the boundary is
covered end to end — a granted recipe may reach an operation whose own grant is
revoked, and a recipe it pairs to may not.

Also: a run that refused every item no longer reports itself successful, a
visitor is told when a public door runs AI before they use it, and the test
suite defaults to the process pool it always needed — the thread pool crashes
this suite outright, which had been rediscovered more than once.

## 26.8.18 — 2026-08-18

This one is mostly about being told the truth. A recipe becomes something you
grant rather than something a pack install implies on your behalf, so what an
agent may run is a list you can read and change. Alongside it, a run of fixes to
the part of chat that reads a model's reply — several shapes of tool call were
being dropped silently, and a turn nobody could read was still reporting itself
finished.

### Added

- **A recipe is now a grant of its own.** Installing a pack used to decide, by
  itself, which of its recipes an agent could reach. `recipe` joins the grant
  kinds, Contracts → Owner → Recipes gives each one a switch, and the install
  screen discloses in advance which recipes it would enable — resolved on your
  server, not guessed by the client. The access ceiling you pick at install time
  is what seeds the grants, so the narrow choice stays narrow.
- **Diagnostics name which gate refused an observation.** Five separate readings
  of the same behaviour were wrong before this existed: a refusal looked
  identical whichever rule produced it. It now says which one.
- **A connection can be tested, and its wire role is detected rather than
  declared.** Settings gets a Test connection button, and the role a provider
  speaks is read off the wire instead of being a field you have to get right.
- **A free-tier provider states what it does with your data** before you route
  anything through it.

### Changed

- **The chat tool loop is a little longer and cheaper to spend.** The main-turn
  ceiling goes from 8 to 10, and a round that only searched for tools no longer
  charges against it — discovery is not work. Tool search is queried in plain
  English.
- **Recipe authoring derives what a guard requires** instead of asking every
  author to remember it, and the validator stopped warning about 28 recipes that
  were fine.

### Fixed

- **The install screen's recipe disclosure had no caller.** The preview shipped
  complete — the rpc, the server handler, the renderer, the risk-scored access
  picker — and nothing called it, so the dialog never showed which recipes an
  install would enable and the access ceiling always fell back to the flattest
  option. One layer down, the composer was never handed what it needed to
  answer, so even a call that arrived would have reported "could not be
  determined" for every recipe on every real server. Both layers were green
  throughout: the tests called the pure functions directly, and the server suite
  supplied a dependency the composition root did not. Paired with a server older
  than this release, the dialog degrades to exactly its pre-disclosure surface
  rather than failing.
- **Tool calls the model really made were being dropped.** A bare native
  tool-use block dispatched nothing at all, silently. Reading now covers every
  shape a model emits, and refuses the one that is only an echo of a call
  already made.
- **A turn that could not be read no longer reports `completed`.** It says so,
  and earns one guided retry — including when the unreadable output is the first
  one, which was the case the earlier fix missed.
- **Every bundled recipe lost its grant on each boot.** The corpus seed rewrote
  them at startup, which also cost 1.7 seconds of every boot.
- **The Back button works from Settings.** The rail switched pages without
  writing an address, so Back left the section entirely rather than returning
  through it.
- **An owner's decision is joinable to what it decided about** in the audit
  trail, which it was not before.
- **`npm run build` failed on a fresh clone of this repository.** A Pro DDNS
  drive under `backend/server/src/dev/` imports `miniflare`, which only ever
  reaches the private tree through a workspace this distribution excludes — so
  the file shipped without its dependency and the build stopped at TS2307. The
  drive is omitted from the export now. It also means the `npm run ci` gate in
  INSTALL.md could not have passed for anyone who cloned; it can now.
- **Four dependency advisories cleared** — a `deepmerge-ts` pin (no upstream fix
  exists: the current html-to-text still requires the affected major), a
  lockfile-lagged `nanoid`, and esbuild moved to 0.28, which also collapses
  three copies of it in the tree into one.

## 26.8.17 — 2026-08-17

A large release, and most of it is about work you already have somewhere else —
documents in OneDrive or SharePoint, a spreadsheet used as a customer list, a
question that needs answering from Teams. Alongside it, a door can now be told
to stop asking, which is what makes a service desk usable at all.

### Added

- **Recued reaches Microsoft Teams, and a Teams ask can be answered by
  typing.** Enrolment runs the OAuth dance in the app rather than sending you
  to a config file. The typed answer is not a nicety: a server on an office LAN
  cannot be reached from a link by design, and Teams cannot deliver a button
  press back to a server that polls — so the message carries both the link and
  the options, and neither is a fallback for the other. The matcher that reads
  your reply is deliberately unhelpful: several things a smarter one would
  obviously do are refused, because the failure it must never have is approving
  something you did not.
- **Documents you already store can be read, not just listed.** A file source
  used to sync only metadata, so a OneDrive or SharePoint document could be
  seen and never opened. Its bytes now reach a converter — and the same path
  serves a synced Dropbox, Box or Notion document. A **Microsoft document
  reader** pack uses it.
- **A spreadsheet becomes answerable.** Look a row up in an Excel workbook and
  get an honest miss rather than an invented one. The thing that actually
  unlocked this was searching your own drive for a file: every Excel operation
  needed two opaque ids, and the only way to get them was to read them by hand
  first.
- **CSV search that works on a fresh machine.** Filtering a CSV used to require
  Python tools you had to install, so a feature could arrive from the
  marketplace and then not run — the worst shape a failure can take. CSV is a
  format we can own, so it moved into the server itself. Converting a
  spreadsheet to CSV still uses an outside tool, deliberately: that one is a
  real project, not a hundred lines.
- **A queue desk** — take a number, see how many are ahead, staff take a
  counter. It fits a bank (types × counters) and a restaurant (table sizes, no
  counter) without being told which. What a business asks a visitor for is left
  open, and no no-show policy is baked in.
- **Fleet Money**, for dispatching a job to a worker and settling it: the job
  carries what it was agreed to be, the worker answers by replying, and the
  money never sits with the worker.
- **Start Recued when you log in** — opt-in, on Windows, macOS and Linux. What
  it installs depends on the machine, because that choice decides whether the
  server can unlock its own keys: a login entry where your keyring is involved,
  a boot service only where nothing needs unlocking.
- **A tool that prints can capture to a file** instead of only to its output.

### Changed

- **A door can be told to stop asking.** A reception visitor or a delegated
  token is held to read-only, so every write waits for you — which makes a
  queue desk unusable, since you would approve every ticket. You can now
  confirm once that the operations you just saw may run without asking, per
  door. It is bounded: destructive and administrative actions still ask, every
  door behaves exactly as before unless you opt it in, and the confirmation is
  part of what the audit trail records.
- **Every token issued to an outside caller now carries a contract.** An
  ordinary token used to have none, and the wire filled the gap with an id that
  named nothing — indistinguishable, further down, from a real one. Existing
  tokens are brought into line at startup. A token's limits and lifetime now
  belong to its contract rather than to the door it came through.
- **Reception access can be ended for one submitter** rather than for
  everybody, and a link can be set to expire when the thing it refers to is
  resolved, or on a date the visitor themselves supplied.

### Fixed

- **A scheduled dispatch said `When: 1583139600000`.** It now says a time.
- **A widened notification rendered blank**, found by a real run rather than a
  test, and every fan-out failure now reaches the one place that notifies.
- **A pack whose release was denied at the scope an owner installs with** — it
  passed at the scope it was tested with.

## 26.8.14 — 2026-08-14

One capability leads this release: your server can serve a domain you already
own, with a certificate Recued issues and renews for you. Alongside it, Recued
now talks to considerably more of the MCP ecosystem than it did, and a tool
reached over MCP is governed in one place instead of two.

### Added

- **Bring your own domain.** Pro can issue and renew a certificate for a name
  you own — `recued.yourcompany.com` rather than a subdomain under
  `recued.net`. Settings → Server → Hostnames walks it: two DNS records,
  presented as one indivisible step, each with its own check. The second record
  is the one that does the work, and the panel says so, because "point my domain
  at Recued and I'm done" is half right — the first record makes the server
  *reachable* while issuance still fails, since the certificate authority
  validates a different name in a zone Recued cannot write. The cards show the
  relative name your DNS provider's form actually wants beside the full one,
  warn about Cloudflare's proxy default next to the record it breaks rather than
  after the check fails, and state that the trailing dot does not matter.
- **Renewal, and a watch on the record it all depends on.** Every custom domain
  renews, not only the address your clients happen to connect to. And because a
  domain whose delegation record was deleted keeps a valid certificate and keeps
  reporting "Verified" for about sixty days before everything fails at once, the
  delegation is now checked on its own and shown in the row beside the
  certificate status. The warning escalates a week out rather than two days out:
  repairing it means editing DNS and waiting for propagation.
- **Somewhere to upload your own certificate.** "Upload my own certificate" had
  been offered as a certificate source with nowhere in the app to upload one.

### Changed

- **Recued negotiates the newest MCP protocol, and its fallback covers the whole
  legacy era.** Recued speaks the current revision to servers that have it. The
  larger fix is underneath: three of the four legacy handshake revisions in
  common use were being refused outright, and the single-endpoint shape most
  deployed remote servers still speak had no path at all. If a remote MCP server
  would not connect, try it again.
- **A tool reached over MCP is governed in one place.** An enrolled MCP tool
  used to be reachable from chat by two routes with two separate gates, so one
  decision was enforced by whichever surface the model happened to pick. The
  per-tool classification you used to set in chat is gone: enrolling an MCP
  connection mints a pack for it on the spot — no second save — and the tool's
  risk tier comes from that pack's operation, resolved through the same rules the
  door reads. Classifications you had made by hand are migrated. The
  per-conversation scope picker retires with it; a peer's tools now arrive in
  the ordinary catalog already governed, so there is nothing to switch between.
- **Settings → Work Entities is gone.** Reads fan out across every source and
  writes are addressed by id, which left a default source and a per-source mute
  with nothing to decide. A Source is a pack, and is managed where packs are.
- **Approval asks are readable.** One live mail-send hold spent seven of its
  eleven lines printing `(null)`. Nothing was dropped — the reader still decides
  which fields matter — but absent, empty and identifier fields each fold onto a
  single labelled line that still names every member, and long ids render as a
  short correlatable prefix instead of in full. An approval surface you skim is
  an approval surface that approves everything.

### Fixed

- **A recipe can tell "it did not happen" from "it has not arrived."** A read
  against a collection now carries a verdict on how current its source is.
  Nothing failed while this was wrong, which is the point: the list call
  succeeds, the filter runs, the count is legitimately zero, and the run is
  legitimately green. The same verdict now rides the searches the AI itself uses
  — mail, calendar and files — which had been the ones dropping it, so a bare
  empty result was reading as a verified absence.
- **A run that refused every item now says so to the agent.** A loop continues
  on error, so a step that refused all ten of its items reported success with no
  errors. Both human surfaces already showed the tally; the agent's view did
  not. It also declines to suggest retrying a partly-refused run, which would
  have re-created the items that did land.
- **The "Renew now" button had no cooldown.** Repeat clicks issued repeat
  certificates against a certificate authority's weekly duplicate allowance,
  which once exhausted breaks automatic renewal too — near expiry, a
  self-inflicted outage.
- **An MCP protocol error no longer rides out on a 200.** A correct error body
  under a success status is read by nobody.
- **Operations belonging to an installed pack are governed at every door**, not
  only the one they were designed for. At the others they had been ungrantable
  rather than merely ungranted. Separately, the internal connection dispatch
  primitive can no longer be bound by an arbitrary recipe; it remains available
  as what it always was, host code.

## 26.8.13 — 2026-08-13

Two capabilities, both about a conversation that leaves your own machine. A
request sent to another person's server can now be answered by a *recipe* on
that server, and the answer resumes the run that was waiting for it. And chat
turns can carry files.

### Added

- **A recipe on the other server can answer.** The previous release let your
  server ask another one a question. This one lets the far side answer with a
  recipe rather than a person: the ask carries where the reply should land, the
  receiving server runs its own recipe under its own owner's rules, and the
  reply resumes the run that was held waiting for it. The authorization is bound
  to the evidence that justified it, so an answer cannot be replayed into a
  different request.
- **Files in chat.** The composer takes attachments, a file dropped in with no
  message behaves the way it does in a messenger, and a turn carrying files goes
  through the same approval gate as anything else that leaves your server —
  compose, approve, send.
- **A mail compose window**, reachable in the app at .
- **Commitment-reliability signals** — four derived facts about whether
  commitments in your world are being met, computed locally like the rest of the
  enrichment substrate.

### Fixed

- **A mail account enrolled after startup now works immediately.** It never
  joined the account registry until the next restart, so enrolling an account
  and sending straight away failed — with an error that pointed at the port
  rather than the cause.
- **Re-uploading a collection sheet no longer doubles the rent**, and a
  fundamentals refresh past 200 periods no longer duplicates history. Both were
  imports counting the same rows twice.
- **One chat notice never arrived.** A resolved data-diagnosis message was
  handled by the app but never subscribed to on the wire, so the branch that
  displayed it could not run.
- **Attachment filenames are escaped**, and an attachment marker now fires on
  the turn the file actually arrives on rather than the one after.

### Changed

- The app's shell cache was rolled twice so a change to how the app talks to
  your server could not linger in a stale browser.

## 26.8.8 — 2026-08-08

One capability dominates this release: a Recued server can now ask *another*
Recued server for something, and get an honest answer back. Alongside it, a
spreadsheet or bank statement can become records without a vendor connection,
and about eighteen new review packs ask a question of a service you already pay
for.

### Added

- **Server-to-server exchange.** Your server can send a request to another
  person's Recued server — a project update, a question, a record — and that
  server answers under its own owner's rules. The part that took the longest was
  not sending; it was making the *failure* useful. "Refused" and "unreachable"
  are now different things, a guard that declines says so rather than implying
  you should try again later, and a peer that cannot reply says that instead of
  going quiet. A request that is worth retrying is retried on a schedule; one
  that is not is not. A recipe can ask what became of a message it sent.
- **Import a file of records in one call.** A CSV — a bank statement, an export
  from another tool, a spreadsheet you keep by hand — becomes records through a
  single gated call, written in batches rather than one row at a time. A
  thousand-row import used to mean a thousand separate writes and a thousand
  audit rows against a quota that evicts the oldest; it is now around ten.
- **Statement import**, which turns a downloaded bank or card statement into
  records without connecting the bank at all. For accounts with no API, or that
  you would rather not connect, the file you can already download is enough.
- **Around eighteen new review packs**, each asking one question of a service
  you are already paying for: Stripe receivables, Zendesk ticket counts, GitHub
  scan coverage, Sentry measured-versus-extrapolated numbers, Twilio and
  PagerDuty reachability, Xero's first-page ceiling, Datadog cost windows,
  LaunchDarkly flag debt, Vercel edge-config exposure, Intercom content
  freshness, Brevo list reach, Close activity time, Asana allocation,
  Elasticsearch access blind spots, OpenAI standing credentials, and PandaDoc
  webhook delivery.
- **Federated projects**, for a project whose participants are on different
  servers.

### Changed

- **You can see what a pack would be allowed to do before you install it.** The
  permissions a pack asks for are shown up front, and where a connection needs
  scopes registered with the provider, the app names them *before* you
  authorize rather than after the authorization fails.

### Fixed

- **Browser Back returns to the list.** On the recipes and data screens the
  device's own Back gesture went somewhere unexpected; it now goes where you
  came from.
- **A connection's slug is shown only when it tells you something** — when two
  connections would otherwise read identically.
- **A failed boot can report itself.** The web app's own content-security policy
  was blocking the script that reports a failed start, so the one case where you
  most need a message produced none.

### Performance

Four places where a screen or a background task read an entire table to find a
handful of rows: cancelling a consumer's queued dispatches, the owner's
pending-approvals view, the blob collector's scan for the small share of rows
that actually carry a blob, and the pinned-row count behind the MCP surface —
the last around 390 times cheaper. None of these changed what you see; they
change how long you wait for it, and they matter most on the servers that have
been running longest.

## 26.8.5 — 2026-08-05

Two things dominate this release. The web app is now measured against a phone
rather than assumed to work on one, and a path that had never actually completed
— issuing a certificate for your own domain from the server — now does.

### Fixed

- **The app fits a phone.** Long values — a contract id, a pack slug, a failure
  message, a reference path — used to push a whole page sideways off screen, so
  the content you were reading moved out from under you. Every surface is now
  measured at 280px and 390px wide and holds its column. Where a strip or a wide
  table is *meant* to scroll sideways, it still does; that is now a deliberate,
  marked exception rather than an accident.
- **Keyboard position is held when a transient notice closes.** Dismissing a
  result banner used to drop focus to the top of the page, which for a keyboard
  or screen-reader user meant losing your place entirely.
- **Touch targets and labels** across Automation, Packs, Recipes, Contracts,
  Connections, Chat, Data, Logs, Reception and Settings — repeated controls now
  have distinguishable names rather than a dozen identical "Retry"s.
- **Certificate issuance for a custom domain could not succeed.** The request was
  capped at 30 seconds, and the signing request used a key type no public
  certificate authority will sign. Both are fixed, failover now decays through
  every configured authority instead of stopping at the first, and recovering an
  account no longer consumes a single-use credential.
- **A published domain name now appears within seconds** of the name being
  claimed, rather than on the next scheduled pass. A server that cannot yet
  provision states why instead of appearing idle.
- A setting stored outside its own table applied nothing and reported nothing —
  it looked saved and did not take effect.

### Changed

- **Your own data is budgeted for a server, not a browser extension.** The stores
  that cannot be re-fetched — your records, your shared data, your memory — were
  limited to 50–100 MB while replaceable copies of remote data were allowed
  gigabytes. That is inverted: the irreplaceable stores now hold up to 5 GB each.
- **Memory and the activity trail are separate.** What you write and keep is
  never pruned. The run-history trail is bounded and drops its oldest entries.
  Previously one name covered both, which made it unclear what could be
  discarded.
- **Chat costs less per turn.** A turn is dominated by the catalog of available
  tools rather than by the conversation; the default now sends a lean core and
  fetches detail on demand.

### Added

- Around twenty new packs, including Snowflake, Databricks, BigQuery, Hex,
  Atlassian Compass, Vanta, Teamwork, Netlify, DigitalOcean, Postmark,
  VirusTotal, Readwise, MusicBrainz, Wikidata, Open Library, Open Food Facts and
  several public-data sources.
- Storage read-out and a Reclaim action under Server ▸ Maintenance, with
  per-surface usage shown in the server popover.
- Request signing for connections, so vendors that authenticate by signing each
  request rather than sending a fixed key can be bound.

### Performance

- The hourly storage check no longer sums the whole activity log; the database
  maintains the total, so the check is constant-time regardless of history size.
- Retention no longer re-scans the entire log once per deleted row.
- Reading the tail of a long chat scaled with conversation length — roughly 400×
  slower at two thousand turns. It is now bounded.
- Cache expiry, prefix invalidation and eviction use indexed range scans instead
  of full passes.

## 26.8.4 — 2026-08-04

Almost all of this release is one thing: work you have started stays yours. The
webclient used to lose in-progress edits, keyboard position, and pending actions
whenever a route repainted, a background read landed, or the page reloaded. That
is now held across every surface.

### Fixed

- **Unsaved work survives navigation, reload, and background repaints.** Drafts,
  filters, selections, pagers, and in-flight actions are retained per surface
  rather than discarded when something else finishes loading. This covers Chat,
  Data, Records, Recipes, Kitchen, Contracts, Connections, Packs, Approvals,
  Reception, Automation, Logs, and Settings.
- **Keyboard focus is owned rather than lost.** After an action completes, focus
  advances to whatever now matters instead of falling back to the page. Where an
  action is refused, focus returns to the control that asked for it, so a
  keyboard user is not left without a position.
- **A leave with unsaved work is confirmed, not silently discarded** — including
  on reload and on switching servers.
- A revoked device now leaves the roster. The revoke was recorded and the refresh
  that should have followed was aborted by an unhandled error, so the device kept
  appearing as active.
- Connections: the Authorize button no longer fails silently, the readiness
  checklist lists only what the owner must actually enter, and the callback URL
  shown is the one this client uses.
- Packs: "Installed only" now filters, and Install is no longer inert on an
  uninstalled pack.

### Added

- **Keyless open-data packs — nothing to sign up for.** Weather Desk (current
  conditions, a seven-day and an hour-by-hour outlook, a schedulable morning
  brief, and a here-without-naming-a-place lookup), air quality with pollen, IP
  geolocation, public flight positions, and case-law retrieval. These need no API
  key and no account.
- 36 further vendor packs and 28 recipes.
- Every recipe now declares the packs it calls, so an install knows what it
  depends on rather than discovering it at run time.

### Changed

- Recipe ids end with the platform they bind to (`check-weather-open-meteo`
  rather than `check-weather`), matching the rest of the corpus. This affects the
  ten open-data recipes added since the last release; nothing previously
  published was renamed.

## 26.8.2 — 2026-08-02

The bulk of this release is a hardening pass over every surface that accepts
work from outside the server, and a matching pass over failures that used to
pass silently.

### Security

- **Every inbound work path now has an explicit ceiling.** The pair/RPC
  WebSocket enforces per-client and global in-flight limits plus a maximum
  payload size; the MCP HTTP transport, trigger dispatch, webhook dispatch and
  reception intake each bound their own concurrent work. Public doors enforce
  per-token concurrency tiers, anonymous recipe cost is capped, paired recipe
  pressure is bounded, and form limits are enforced per source. Previously a
  single client — buggy or hostile — could enqueue without limit.
- Door dispatch authority is resolved once and pinned, and every authority axis
  is diffed rather than spot-checked.
- OAuth provider runtime origins are pinned.
- Providers reject malformed pagination state instead of continuing from it.

### Added

- **Server receipts reach the webclient.** Server-side action outcomes are
  carried into Attention, unresolved receipts can be reviewed and reconciled,
  and diagnosis hands off to the server controls that can act on it — so a
  failure that happened while nobody was looking is visible and actionable
  rather than lost.
- Work-entity sources gain a read-through posture, qualified source id routing,
  and required landing adapters; first-party task sources move into packs, so a
  source is declared the same way whether it ships with the server or with a
  pack (D-192).
- MCP persists approval continuations, so an approval that outlives the
  connection can still be resumed.

### Fixed

- Failures that were previously swallowed now surface: vault resume, watch
  polling, scheduler background work, and file/MCP credential-refresh
  persistence all report rather than fail quietly.
- IMAP reconnects drain instead of accumulating; vault sync edges are
  serialized; every listener branch is closed on shutdown.
- A resumed audit entry keeps its original start time.
- The release manifest is published at every known channel path, not only the
  declared ones. An edge-channel server resolves to stable when no edge channel
  is declared, but still fetches `/edge/manifest.json` — so a stable-only
  release previously 404'd every edge server's update check.

## 26.8.1 — 2026-08-01

### Security

- **`nodemailer` is now `^9.0.3`.** The advisory affects the whole `8.x` line
  (`<=9.0.0`), so no patch release could clear it. The IMAP/SMTP send path
  submits with the exact option named in it — a message-level `raw` body, which
  bypassed `disableFileAccess` / `disableUrlAccess` and allowed arbitrary file
  read and full-response SSRF in the delivered message.
- `ws` is now `^8.21.1`, closing a memory-exhaustion denial of service reachable
  from the pairing and RPC transport, and `imapflow` moves to `1.6.5`. The
  dependency projection also picks up `libmime`, `mailsplit`, `iconv-lite`,
  `semver`, `socks`, and `ip-address`.

### Added

- **Pack-owned records (D-221).** Packs declare fixed relational storage with
  pack-wide version anchoring, and the reachable list operations hand back the
  ids they list, so a listed row can be acted on without a second lookup.
- **MCP as a declared surface (D-225).** Surfaces are declared rather than
  inferred, and their kernel packs are generated from that declaration.
- Recipe variables can be supplied as invocation arguments, with a rendered
  filter block for the caller (D-222); publishers may suggest connection values
  as hints without widening the schema a user controls (D-223).
- The webclient gains recovery flows for interrupted work — resuming paused and
  resolved recovery intents, reorienting stale ones, and recovering failed
  rechecks from Attention.
- `CLAUDE.md`, a short orientation file for AI coding assistants working in this
  repository. It links `ARCHITECTURE.md` and `CONTRIBUTING.md` rather than
  restating them.

### Changed

- **BREAKING — Tier-1 primitives are now gated by contract on the MCP wire and
  the chat channel (D-228.5).** Every tier-1 registry dispatch resolves through
  the operation admission gate. This is a second axis, not a replacement: a
  token's checklist says what that token may use, the contract says what the
  door may ever be granted, and both must pass — so a token can never widen past
  its contract. An owner with an unbound token and a wildcard door still admit.
  A one-time grandfather writes an explicit grant per previously-usable
  primitive, because the author default is fail-closed for scoped doors and
  customer instances and no such row could have existed before this release —
  without it, upgrading would have silently stripped operations like
  `mail.search` and `recipe.run` from every scoped contract.
- Recipe arguments now declare optionality honestly. 108 arguments across the
  corpus were presented to callers as optional when they were not.
- The release manifest is served per channel at
  `releases.recued.com/<channel>/manifest.json`. The bytes are identical at
  every path — one signature, one sequence, every channel inside each copy — so
  signature verification and the anti-replay floor are unchanged.
- The update check identifies itself as `recued/<version> (<platform>;
  <distribution-channel>)`. Every field is already computed for the check
  itself, nothing new is collected, and nothing in it is per-instance: two
  servers alike in those fields send byte-identical requests.

### Fixed

- The baked Docker image could not start — it rebuilt the wrong SQLite driver.
- A recipe-keyed watcher could not cross the pair RPC, and a webhook queue is
  now owned by the recipe draining it (D-228).
- The Learning panel crashed on a field that had stopped claiming a route
  (D-219).

## 26.7.26 — 2026-07-26

### Added

- Owner feedback on a chat execution can be retracted:
  `chat.execution.feedback.retract` withdraws one exact feedback fact and
  deterministically recompiles the affected span. As with the rest of the
  feedback surface, the caller names no case or feedback row.
- An `element.changed` shorthand for DOM watch triggers, alongside the existing
  trigger sugar.

### Changed

- `@recued/contracts` now declares `sideEffects`, so bundlers can tree-shake
  the modules that have none.
- Execution-case handling is tightened throughout: case grounding, experiment
  invariants, critic behaviour, retrieval, and the case vocabulary.

## 26.7.25 — 2026-07-25

### Added

- Encryption at rest for the server realm database, with production blobs keyed
  by default and a single database-open chokepoint.
- The Day-1 foundation packs and the recipes they reference now ship as JSON
  under `community/`, so the authoring guides have a local worked example.
- `ARCHITECTURE.md` and `CONTRIBUTING.md`.

### Changed

- Cloud document-provider files now have one credential authority: a connection
  owns enrollment, refresh, and revocation. The `collection.file.reauth` RPC is
  removed — re-consent goes through Data → Files → Add connection.
- The README points at <https://recued.com/docs> for installing, pairing, and
  authoring.

### Removed

- Internal benchmark tooling is no longer part of the published tree.

## 26.7.3 — 2026-07-20

### Added

- Initial AGPL-3.0-only public source export: the self-hosted server, the
  webclient, and the workspace packages they are built from.
- Reproducible public dependency projection and committed-source provenance
  metadata.
