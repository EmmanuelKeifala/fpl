# LLM News Backtest Experiments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a small multi-season experiment runner for deterministic fair, strict-news hybrid LLM, and loose-news hybrid LLM backtests.

**Architecture:** Add focused experiment modules under `src/backtest/experiments/`. Candidate generation remains deterministic and legal; a ranker interface chooses among prevalidated candidates. News and ranker calls are cache-first and best-effort so experiments can run without repeatedly hitting external services.

**Tech Stack:** TypeScript, Node `fetch`, built-in `node:test`, existing backtest engine/snapshot/report modules.

---

### Task 1: Candidate Generation And Hybrid Strategy

**Files:**
- Create: `src/backtest/experiments/candidates.ts`
- Create: `src/backtest/experiments/hybrid-strategy.ts`
- Test: `src/backtest/experiments/hybrid-strategy.test.ts`

- [ ] Add tests proving generated candidates include a hold decision and selected ranked decisions are applied unchanged.
- [ ] Implement `buildCandidateDecisions` with bounded legal candidates based on current squad, fair transfer helper, and current lineup.
- [ ] Implement `createHybridStrategy` that calls a ranker with candidates and returns the selected candidate.
- [ ] Run `npx tsx --test src/backtest/experiments/hybrid-strategy.test.ts`.
- [ ] Commit `Add hybrid backtest candidate strategy`.

### Task 2: News Cache And GDELT Fetcher

**Files:**
- Create: `src/backtest/experiments/news.ts`
- Test: `src/backtest/experiments/news.test.ts`

- [ ] Add tests for strict timestamp filtering, loose warnings, cache reuse, and fetch failure warnings.
- [ ] Implement news item types, cache file paths, GDELT query URL construction, best-effort fetch, strict/loose filtering, and provenance warnings.
- [ ] Run `npx tsx --test src/backtest/experiments/news.test.ts`.
- [ ] Commit `Add historical news context cache`.

### Task 3: Ranker Cache And LLM Adapter

**Files:**
- Create: `src/backtest/experiments/ranker.ts`
- Test: `src/backtest/experiments/ranker.test.ts`

- [ ] Add tests for response cache reuse, invalid selection fallback, and deterministic no-key fallback warning.
- [ ] Implement prompt input hashing, JSON response cache, OpenAI-compatible HTTP call when `OPENAI_API_KEY` is present, and deterministic fallback when absent.
- [ ] Run `npx tsx --test src/backtest/experiments/ranker.test.ts`.
- [ ] Commit `Add cached experiment ranker`.

### Task 4: Multi-Season Experiment Runner

**Files:**
- Create: `src/backtest/experiments/runner.ts`
- Test: `src/backtest/experiments/runner.test.ts`
- Modify: `src/backtest/index.ts`
- Modify: `package.json`

- [ ] Add tests for matrix summary aggregation and CLI parser defaults.
- [ ] Implement experiment configs for `fair`, `llm-news-strict`, and `llm-news-loose` over the four target seasons.
- [ ] Add `backtest:experiment` script and CLI command requiring `--allow-llm-news` before live news/LLM behavior.
- [ ] Run `npx tsx --test src/backtest/experiments/runner.test.ts src/backtest/index.test.ts`.
- [ ] Commit `Add multi-season LLM news experiment runner`.

### Task 5: Verification

**Files:**
- No code changes expected.

- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run a dry smoke experiment using cached/fallback ranker with one season and one config.
- [ ] Report command output and remaining limitations.

### Self-Review

- Spec coverage: hybrid ranker, strict/loose news, cache-first behavior, experiment reports, and cost guardrails are covered.
- Placeholder scan: no placeholders remain.
- Type consistency: experiment modules use `BacktestDecision`, `BacktestStrategy`, `GameweekSnapshot`, and `BacktestReport` from existing backtest types.
