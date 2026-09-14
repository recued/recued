# Changelog

All notable changes to the public Recued source distribution will be recorded here.

Versions are calendar-based (`yy.m.d`, US Pacific) and name the day the source
checkpoint was cut. One entry per published export; the machine-readable
provenance for each — source commit, tree, payload digest, and what was omitted
— lives in `.recued-public-export.json`.

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
