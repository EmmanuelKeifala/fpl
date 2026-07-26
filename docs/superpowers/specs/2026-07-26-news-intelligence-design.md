# News Intelligence Design

## Goal

Turn pre-deadline official updates, injuries, suspensions, predicted lineups, and trusted leaks into auditable player availability signals that directly improve expected minutes, transfers, lineup selection, and captaincy.

## Signal Model

Each signal records player ID/name, type, source, source tier, publication and retrieval times, confidence, expected-minutes multiplier, expiry, evidence, and whether it was available before the deadline. Supported types are `injured`, `doubtful`, `ruled-out`, `suspended`, `expected-start`, `expected-bench`, and `returning`.

Official FPL status/news is tier 1. Proven lineup reporters and official clubs are tier 2. Established FPL analysts are tier 3. Generic websites and keyword extraction are tier 4. Tier and recency determine confidence; lower-tier negative claims require corroboration before forcing a transfer or benching a highly projected player.

## Pipeline

Gather official FPL fields and timestamped external items, reject post-deadline and stale items, resolve player names against current FPL players, extract signal types, merge conflicts by source tier/confidence, and persist both raw evidence and the effective signal. Website content without a publication timestamp can inform live monitoring but is marked low confidence and cannot enter strict historical replay.

The optimizer applies the effective signal to appearance probability and expected minutes before calculating points. Ruled-out and suspended players project zero; doubtful and expected-bench signals reduce minutes; expected-start and returning signals can restore minutes but never exceed the player's healthy baseline. Captaincy and lineup selection consume these adjusted projections automatically.

## Deadline Behavior

Normal polling remains configured by `POLL_INTERVAL_MINUTES`. Inside 90 minutes of the deadline, poll every five minutes by default. Signals expire after the target deadline and never carry into another gameweek without fresh evidence.

## Learning

Persist signals with target gameweek and reconcile them against actual starts/minutes. Maintain source observations so later work can calibrate reliability. Do not add new tests in this phase; verify with the existing suite, build, and a dry decision-context cycle where credentials permit.

## Safety

News processing never executes FPL mutations directly. Existing emergency-stop and auto-execution controls remain authoritative. Missing, malformed, undated, or conflicting evidence defaults to the ordinary projection rather than an aggressive action.
