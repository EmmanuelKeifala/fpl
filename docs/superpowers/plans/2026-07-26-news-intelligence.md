# News Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert pre-deadline official updates and trusted leaks into persistent player signals that adjust expected minutes and autonomous decisions.

**Architecture:** Add a pure signal extraction/merging module between raw news collection and the optimizer. Resolve news to current FPL player IDs, filter by deadline and source quality, persist effective signals, and apply only the merged expected-minutes multiplier inside the existing projection engine.

**Tech Stack:** TypeScript, existing FPL API client, scheduler, optimizer, and SQL.js persistence.

**Constraint:** Add no new tests; verify with the existing suite and build.

---

### Task 1: Structured Signals

**Files:** Create `src/scheduler/news-signals.ts`; modify `src/scheduler/news.ts`.

- [ ] Define `PlayerNewsSignal` with target gameweek, player, type, source tier, confidence, multiplier, timestamps, expiry, and evidence.
- [ ] Mark Twitter timestamps verified and scraped website timestamps unverified.
- [ ] Resolve normalized full names, surname, and `web_name` against current FPL players.
- [ ] Extract injury, doubt, suspension, start, bench, and return signals.
- [ ] Reject verified post-deadline items and merge conflicts by tier, confidence, corroboration, and recency.

### Task 2: Official Signals and Persistence

**Files:** Modify `src/db/client.ts`; modify `src/scheduler/decisions.ts`.

- [ ] Build tier-1 signals from FPL status, chance-to-play, and player news.
- [ ] Add a `player_news_signals` table and `savePlayerNewsSignals()` using the existing schema-initialization pattern.
- [ ] Gather, merge, persist, and expose effective signals in `DecisionContext`.

### Task 3: Projection Integration

**Files:** Modify `src/engine/optimizer.ts`; modify `src/scheduler/decisions.ts`.

- [ ] Add `setNewsSignals()` and an internal player-signal map to `OptimizationEngine`.
- [ ] Multiply healthy expected minutes and appearance probability by the effective signal without exceeding baseline values.
- [ ] Include news confidence and multiplier in projection breakdown.
- [ ] Install signals before transfer, lineup, chip, and captain calculations consume projections.

### Task 4: Deadline Polling and Verification

**Files:** Modify `src/scheduler/runner.ts`; modify `.env.example`; modify `README.md`.

- [ ] Poll every `DEADLINE_NEWS_POLL_MINUTES` inside `DEADLINE_NEWS_WINDOW_MINUTES`, defaulting to five and ninety.
- [ ] Document source trust, timestamp filtering, and safety behavior.
- [ ] Run `npm test`, `npm run build`, and `git diff --check`.
- [ ] Commit all news intelligence changes.
