# LLM Experiment Variation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LLM/news backtest experiments produce auditable strategy variation through real config variants, broader legal candidate slates, and explicit stochastic runs.

**Architecture:** Keep the existing hybrid design: deterministic code generates legal candidate decisions and the LLM chooses one by id. Add a focused config module, expand candidate generation behind config options, pass config metadata through the hybrid strategy and ranker, and enrich experiment summaries with choice/fallback telemetry. Deterministic runs remain cache-stable; stochastic runs use explicit run ids in cache identity.

**Tech Stack:** TypeScript, Node test runner via `tsx --test`, existing FPL backtest engine, OpenAI Responses API through `fetch`.

---

## File Structure

- Create `src/backtest/experiments/configs.ts`: owns experiment config definitions, config selection, stochastic temperature resolution, and run id creation.
- Modify `src/backtest/experiments/candidates.ts`: accepts config-like generation options and returns multiple legal candidates.
- Modify `src/backtest/experiments/hybrid-strategy.ts`: accepts an `ExperimentConfig`, passes it into candidate generation/ranker input, and annotates decisions with selected candidate id.
- Modify `src/backtest/experiments/ranker.ts`: includes config prompt/temperature/run id in OpenAI request and cache key.
- Modify `src/backtest/experiments/runner.ts`: separates modes from configs, parses stochastic flags, runs fair once, runs each selected config per LLM mode, and reports telemetry.
- Modify tests in `src/backtest/experiments/*.test.ts`: cover config parsing, candidate variety, stochastic cache identity, and summary telemetry.

---

### Task 1: Add Experiment Config Definitions

**Files:**
- Create: `src/backtest/experiments/configs.ts`
- Test: `src/backtest/experiments/runner.test.ts`

- [ ] **Step 1: Write failing config tests**

Add imports at the top of `src/backtest/experiments/runner.test.ts`:

```ts
import { createRunId, selectExperimentConfigs } from './configs.js';
```

Add these tests after the existing parse tests:

```ts
test('selectExperimentConfigs returns stable default config order', () => {
  assert.deepEqual(selectExperimentConfigs(3).map(config => config.id), ['balanced', 'aggressive', 'conservative']);
});

test('selectExperimentConfigs rejects invalid max config counts', () => {
  assert.throws(() => selectExperimentConfigs(0), /Invalid max configs/);
});

test('createRunId returns a short lowercase id', () => {
  assert.match(createRunId(), /^[a-z0-9]{8}$/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/backtest/experiments/runner.test.ts`

Expected: FAIL because `./configs.js` does not exist.

- [ ] **Step 3: Create config module**

Create `src/backtest/experiments/configs.ts`:

```ts
import { randomBytes } from 'node:crypto';

export type ExperimentConfigId = 'balanced' | 'aggressive' | 'conservative' | 'differential' | 'news-sensitive';

export interface ExperimentConfig {
  id: ExperimentConfigId;
  promptBias: string;
  model: string;
  deterministicTemperature: number;
  stochasticTemperature: number;
  candidateCount: number;
  allowHits: boolean;
  hitThreshold: number;
  preferDifferentials: boolean;
  newsSensitivity: 'normal' | 'high';
}

export const EXPERIMENT_CONFIGS: ExperimentConfig[] = [
  {
    id: 'balanced',
    promptBias: 'Choose the candidate with the best balance of projected points, transfer discipline, and captaincy reliability.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.4,
    candidateCount: 6,
    allowHits: false,
    hitThreshold: 4.5,
    preferDifferentials: false,
    newsSensitivity: 'normal',
  },
  {
    id: 'aggressive',
    promptBias: 'Prefer upside. Accept calculated hits and bold captain choices when projected gain justifies the risk.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.7,
    candidateCount: 8,
    allowHits: true,
    hitThreshold: 3.5,
    preferDifferentials: false,
    newsSensitivity: 'normal',
  },
  {
    id: 'conservative',
    promptBias: 'Prefer robust choices. Avoid unnecessary transfers and never take hits unless explicitly unavailable in this config.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.2,
    candidateCount: 5,
    allowHits: false,
    hitThreshold: Number.POSITIVE_INFINITY,
    preferDifferentials: false,
    newsSensitivity: 'normal',
  },
  {
    id: 'differential',
    promptBias: 'Prefer high-upside lower-owned candidates when projected points are close. Do not sacrifice large expected value gaps.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.6,
    candidateCount: 8,
    allowHits: false,
    hitThreshold: 4.5,
    preferDifferentials: true,
    newsSensitivity: 'normal',
  },
  {
    id: 'news-sensitive',
    promptBias: 'Use credible news heavily when it affects minutes, injury risk, suspensions, or likely starts. If news is empty, behave like balanced.',
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    deterministicTemperature: 0,
    stochasticTemperature: 0.5,
    candidateCount: 6,
    allowHits: false,
    hitThreshold: 4.5,
    preferDifferentials: false,
    newsSensitivity: 'high',
  },
];

export function selectExperimentConfigs(maxConfigs: number): ExperimentConfig[] {
  if (!Number.isInteger(maxConfigs) || maxConfigs < 1) throw new Error('Invalid max configs');
  return EXPERIMENT_CONFIGS.slice(0, maxConfigs);
}

export function resolveTemperature(config: ExperimentConfig, stochastic: boolean): number {
  return stochastic ? config.stochasticTemperature : config.deterministicTemperature;
}

export function createRunId(): string {
  return randomBytes(4).toString('hex');
}
```

- [ ] **Step 4: Run config tests**

Run: `npx tsx --test src/backtest/experiments/runner.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backtest/experiments/configs.ts src/backtest/experiments/runner.test.ts
git commit -m "Add LLM experiment configs"
```

---

### Task 2: Generate Multiple Legal Candidates

**Files:**
- Modify: `src/backtest/experiments/candidates.ts`
- Test: `src/backtest/experiments/hybrid-strategy.test.ts`

- [ ] **Step 1: Write failing candidate variation tests**

In `src/backtest/experiments/hybrid-strategy.test.ts`, replace the existing `buildCandidateDecisions includes hold and transfer candidates` test with:

```ts
test('buildCandidateDecisions includes several one-transfer alternatives', () => {
  const squad = legalSquadPlayers();
  const replacements = [
    player(99, 12, 45, 3, 99),
    player(100, 11.5, 45, 3, 100),
    player(101, 11, 45, 3, 101),
  ];
  const candidates = buildCandidateDecisions({
    state: stateWithSquad(squad),
    snapshot: {
      season: '2024-2025', gameweek: 2, deadline: '2024-08-24T10:00:00Z',
      knownBeforeDeadline: { players: [...squad, ...replacements], fixtures: [], unavailableFields: [] },
      provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
    },
    maxCandidates: 4,
  });

  assert.deepEqual(candidates.map(candidate => candidate.id), ['hold', 'transfer-1', 'transfer-2', 'transfer-3']);
  assert.deepEqual(candidates.slice(1).map(candidate => candidate.decision.transfers[0]?.in), [99, 100, 101]);
});

test('buildCandidateDecisions excludes hit candidates unless allowed', () => {
  const squad = legalSquadPlayers();
  const replacements = [player(99, 12, 45, 3, 99), player(100, 11.5, 45, 4, 100)];
  const snapshot = {
    season: '2024-2025', gameweek: 2, deadline: '2024-08-24T10:00:00Z',
    knownBeforeDeadline: { players: [...squad, ...replacements], fixtures: [], unavailableFields: [] },
    provenance: { sourceUrls: ['https://example.test'], downloadedAt: '2026-05-20T00:00:00.000Z', snapshotVersion: 'v1', knownLimitations: [] },
  };

  const conservative = buildCandidateDecisions({ state: stateWithSquad(squad), snapshot, allowHits: false, maxCandidates: 8 });
  const aggressive = buildCandidateDecisions({ state: stateWithSquad(squad), snapshot, allowHits: true, hitThreshold: 0, maxCandidates: 8 });

  assert.equal(conservative.some(candidate => candidate.id.startsWith('hit-')), false);
  assert.equal(aggressive.some(candidate => candidate.id.startsWith('hit-')), true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/backtest/experiments/hybrid-strategy.test.ts`

Expected: FAIL because only `best-transfer` is generated and hit candidates are unsupported.

- [ ] **Step 3: Implement candidate expansion**

Update `CandidateBuildInput` in `src/backtest/experiments/candidates.ts`:

```ts
export interface CandidateBuildInput {
  state: ManagerState;
  snapshot: DecisionSnapshotInput;
  maxCandidates?: number;
  allowHits?: boolean;
  hitThreshold?: number;
}
```

Replace the body of `buildCandidateDecisions` after the GW1 branch with:

```ts
  const candidates: CandidateDecision[] = [buildCandidate('hold', 'Hold squad', input.snapshot.gameweek, currentIds, [], playersById)];
  const transferChoices = chooseTransferAlternatives({
    squad: input.state.squad,
    bank: input.state.bank,
    freeTransfers: input.state.freeTransfers,
    players: input.snapshot.knownBeforeDeadline.players,
    maxCandidatesPerPosition: 12,
    hitThreshold: input.hitThreshold ?? 4.5,
    maxAlternatives: maxCandidates - 1,
  });
  transferChoices.forEach((choice, index) => {
    const idsAfterTransfers = applyTransferIds(currentIds, choice.transfers);
    candidates.push(buildCandidate(`transfer-${index + 1}`, `Transfer alternative ${index + 1}`, input.snapshot.gameweek, idsAfterTransfers, choice.transfers, playersById));
  });

  if (input.allowHits) {
    const hitChoices = chooseHitAlternatives({
      squad: input.state.squad,
      bank: input.state.bank,
      players: input.snapshot.knownBeforeDeadline.players,
      hitThreshold: input.hitThreshold ?? 4.5,
      maxAlternatives: maxCandidates - candidates.length,
    });
    hitChoices.forEach((choice, index) => {
      const idsAfterTransfers = applyTransferIds(currentIds, choice.transfers);
      candidates.push(buildCandidate(`hit-${index + 1}`, `Hit alternative ${index + 1}`, input.snapshot.gameweek, idsAfterTransfers, choice.transfers, playersById));
    });
  }

  return candidates.slice(0, maxCandidates);
```

Remove the unused `chooseBestTransfers` import. Add `calculateSellingPrice`, `FPL_RULES`, `POSITION_BY_ELEMENT_TYPE`, and `validateSquad` imports:

```ts
import { calculateSellingPrice, FPL_RULES, POSITION_BY_ELEMENT_TYPE } from '../../strategy/rules.js';
import { validateSquad } from '../../strategy/squad.js';
```

Add these helper interfaces and functions below `buildCandidateDecisions`:

```ts
interface AlternativeInput {
  squad: SquadPick[];
  bank: number;
  freeTransfers?: number;
  players: BacktestPlayer[];
  maxCandidatesPerPosition?: number;
  hitThreshold: number;
  maxAlternatives: number;
}

interface TransferAlternative {
  transfers: TransferMove[];
  projectedGain: number;
}

function chooseTransferAlternatives(input: AlternativeInput): TransferAlternative[] {
  const choices = singleTransferChoices(input, input.freeTransfers ?? 1)
    .filter(choice => choice.projectedGain > 0)
    .sort((a, b) => b.projectedGain - a.projectedGain || a.transfers[0]!.in - b.transfers[0]!.in);
  return dedupeTransferChoices(choices).slice(0, Math.max(0, input.maxAlternatives));
}

function chooseHitAlternatives(input: AlternativeInput): TransferAlternative[] {
  if (input.maxAlternatives <= 0) return [];
  const singles = singleTransferChoices({ ...input, maxAlternatives: 20 }, 1).slice(0, 8);
  const playersById = new Map(input.players.map(player => [player.id, player]));
  const results: TransferAlternative[] = [];
  for (let i = 0; i < singles.length; i++) {
    for (let j = i + 1; j < singles.length; j++) {
      const transfers = [...singles[i]!.transfers, ...singles[j]!.transfers];
      if (new Set(transfers.map(transfer => transfer.out)).size !== transfers.length) continue;
      if (new Set(transfers.map(transfer => transfer.in)).size !== transfers.length) continue;
      const finalIds = applyTransferIds(input.squad.map(pick => pick.playerId), transfers);
      const finalPlayers = finalIds.map(id => playersById.get(id)).filter(Boolean) as BacktestPlayer[];
      const bankAfter = calculateBankAfterTransfers(input.squad, input.bank, transfers, playersById);
      if (bankAfter < 0 || !validateSquad(finalPlayers, finalPlayers.reduce((total, player) => total + player.price, bankAfter)).valid) continue;
      const projectedGain = scoreSquad(finalPlayers) - scoreSquad(input.squad.map(pick => playersById.get(pick.playerId)).filter(Boolean) as BacktestPlayer[]) - FPL_RULES.hitCost;
      if (projectedGain >= input.hitThreshold) results.push({ transfers, projectedGain });
    }
  }
  return dedupeTransferChoices(results.sort((a, b) => b.projectedGain - a.projectedGain)).slice(0, input.maxAlternatives);
}

function singleTransferChoices(input: AlternativeInput, freeTransfers: number): TransferAlternative[] {
  const playersById = new Map(input.players.map(player => [player.id, player]));
  const squadIds = new Set(input.squad.map(pick => pick.playerId));
  const currentScore = scoreSquad(input.squad.map(pick => playersById.get(pick.playerId)).filter(Boolean) as BacktestPlayer[]);
  const choices: TransferAlternative[] = [];
  const candidates = candidatePlayers(input.players, input.maxCandidatesPerPosition ?? 12).filter(player => !squadIds.has(player.id));
  for (const outgoing of input.squad) {
    const outgoingPlayer = playersById.get(outgoing.playerId);
    if (!outgoingPlayer) continue;
    for (const incoming of candidates) {
      if (incoming.elementType !== outgoingPlayer.elementType) continue;
      const transfers = [{ out: outgoing.playerId, in: incoming.id }];
      const bankAfter = calculateBankAfterTransfers(input.squad, input.bank, transfers, playersById);
      if (bankAfter < 0) continue;
      const finalPlayers = applyTransferIds(input.squad.map(pick => pick.playerId), transfers).map(id => playersById.get(id)).filter(Boolean) as BacktestPlayer[];
      if (!validateSquad(finalPlayers, finalPlayers.reduce((total, player) => total + player.price, bankAfter)).valid) continue;
      const hitCost = freeTransfers >= 1 ? 0 : FPL_RULES.hitCost;
      const projectedGain = scoreSquad(finalPlayers) - currentScore - hitCost;
      choices.push({ transfers, projectedGain });
    }
  }
  return choices;
}

function candidatePlayers(players: BacktestPlayer[], maxPerPosition: number): BacktestPlayer[] {
  const result: BacktestPlayer[] = [];
  for (const elementType of [1, 2, 3, 4]) {
    result.push(...players
      .filter(player => POSITION_BY_ELEMENT_TYPE[player.elementType] && player.elementType === elementType)
      .sort((a, b) => b.expectedPoints - a.expectedPoints || a.price - b.price || a.id - b.id)
      .slice(0, maxPerPosition));
  }
  return result;
}

function calculateBankAfterTransfers(squad: SquadPick[], bank: number, transfers: TransferMove[], playersById: Map<number, BacktestPlayer>): number {
  let result = bank;
  for (const transfer of transfers) {
    const outgoingPick = squad.find(pick => pick.playerId === transfer.out);
    const outgoingPlayer = playersById.get(transfer.out);
    const incomingPlayer = playersById.get(transfer.in);
    if (!outgoingPick || !outgoingPlayer || !incomingPlayer) return Number.NEGATIVE_INFINITY;
    result += calculateSellingPrice(outgoingPick.purchasePrice, outgoingPlayer.price) - incomingPlayer.price;
  }
  return result;
}

function dedupeTransferChoices(choices: TransferAlternative[]): TransferAlternative[] {
  const seen = new Set<string>();
  const result: TransferAlternative[] = [];
  for (const choice of choices) {
    const key = choice.transfers.map(transfer => `${transfer.out}:${transfer.in}`).sort().join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(choice);
  }
  return result;
}

function scoreSquad(players: BacktestPlayer[]): number {
  return players.reduce((total, player) => total + player.expectedPoints, 0);
}
```

- [ ] **Step 4: Run candidate tests**

Run: `npx tsx --test src/backtest/experiments/hybrid-strategy.test.ts`

Expected: PASS.

- [ ] **Step 5: Run full tests**

Run: `npm test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backtest/experiments/candidates.ts src/backtest/experiments/hybrid-strategy.test.ts
git commit -m "Expand hybrid experiment candidates"
```

---

### Task 3: Pass Config Metadata Through Strategy And Ranker

**Files:**
- Modify: `src/backtest/experiments/hybrid-strategy.ts`
- Modify: `src/backtest/experiments/ranker.ts`
- Test: `src/backtest/experiments/ranker.test.ts`
- Test: `src/backtest/experiments/hybrid-strategy.test.ts`

- [ ] **Step 1: Write failing metadata tests**

In `src/backtest/experiments/ranker.test.ts`, add `config` and stochastic fields to `rankerInput()`:

```ts
    config: {
      id: 'aggressive' as const,
      promptBias: 'Prefer upside.',
      model: 'test-model',
      deterministicTemperature: 0,
      stochasticTemperature: 0.7,
      candidateCount: 6,
      allowHits: true,
      hitThreshold: 3.5,
      preferDifferentials: false,
      newsSensitivity: 'normal' as const,
    },
    temperature: 0.7,
    stochastic: true,
    runId: 'abc12345',
```

In `createCachedRanker constrains OpenAI output to candidate id schema`, add assertions:

```ts
      assert.equal(requestBody.model, 'test-model');
      assert.equal(requestBody.temperature, 0.7);
      assert.match(requestBody.input[0].content, /Prefer upside/);
```

Add a new test:

```ts
test('createCachedRanker includes stochastic run id in cache identity', async () => {
  await withTempDir(async cacheDir => {
    let calls = 0;
    const ranker = createCachedRanker({
      cacheDir,
      provider: async () => {
        calls++;
        return { candidateId: 'best-transfer', explanation: `choice ${calls}` };
      },
    });

    await ranker({ ...rankerInput(), runId: 'run-one' });
    await ranker({ ...rankerInput(), runId: 'run-two' });

    assert.equal(calls, 2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/backtest/experiments/ranker.test.ts`

Expected: FAIL because `HybridRankerInput` lacks config/stochastic fields and ranker ignores them.

- [ ] **Step 3: Update hybrid ranker input types**

In `src/backtest/experiments/hybrid-strategy.ts`, import `ExperimentConfig`:

```ts
import type { ExperimentConfig } from './configs.js';
```

Update `HybridRankerInput`:

```ts
export interface HybridRankerInput {
  state: ManagerState;
  snapshot: DecisionSnapshotInput;
  candidates: CandidateDecision[];
  news: unknown[];
  mode: 'llm-news-strict' | 'llm-news-loose';
  configId: string;
  config: ExperimentConfig;
  temperature: number;
  stochastic: boolean;
  runId?: string;
}
```

Update `HybridStrategyOptions`:

```ts
export interface HybridStrategyOptions {
  ranker: HybridRanker;
  config: ExperimentConfig;
  temperature: number;
  stochastic: boolean;
  runId?: string;
  mode?: 'llm-news-strict' | 'llm-news-loose';
  getNews?: (input: { state: ManagerState; snapshot: DecisionSnapshotInput; mode: 'llm-news-strict' | 'llm-news-loose' }) => Promise<unknown[]>;
}
```

Update `createHybridStrategy` to use config:

```ts
export function createHybridStrategy(options: HybridStrategyOptions): BacktestStrategy {
  const mode = options.mode ?? 'llm-news-strict';
  const configId = options.config.id;
  return async ({ state, snapshot }) => {
    const candidates = buildCandidateDecisions({
      state,
      snapshot,
      maxCandidates: options.config.candidateCount,
      allowHits: options.config.allowHits,
      hitThreshold: options.config.hitThreshold,
    });
    const news = await (options.getNews?.({ state, snapshot, mode }) ?? Promise.resolve([]));
    const ranked = await options.ranker({
      state,
      snapshot,
      candidates,
      news,
      mode,
      configId,
      config: options.config,
      temperature: options.temperature,
      stochastic: options.stochastic,
      runId: options.runId,
    });
    const selected = candidates.find(candidate => candidate.id === ranked.candidateId) ?? candidates[0];
    return annotateDecision(selected.decision, selected.id, ranked.explanation);
  };
}
```

Update `annotateDecision`:

```ts
function annotateDecision(decision: BacktestDecision, candidateId: string, explanation: string): BacktestDecision {
  return {
    ...decision,
    notes: [...decision.notes, `LLM hybrid selected ${candidateId}: ${explanation}`],
  };
}
```

Update `hybrid-strategy.test.ts` `createHybridStrategy` call by importing `EXPERIMENT_CONFIGS` and passing the first config:

```ts
import { EXPERIMENT_CONFIGS } from './configs.js';

const strategy = createHybridStrategy({
  config: EXPERIMENT_CONFIGS[0]!,
  temperature: 0,
  stochastic: false,
  ranker: async input => ({ candidateId: input.candidates[1]!.id, explanation: 'higher expected points' }),
});
```

Update the note assertion:

```ts
assert.equal(decision.notes.some(note => note.includes('LLM hybrid selected transfer-1: higher expected points')), true);
```

- [ ] **Step 4: Update ranker request and cache**

In `src/backtest/experiments/ranker.ts`, remove model from `CachedRankerOptions` and derive from input config. Update cache path call:

```ts
const cachePath = rankerCachePath(options.cacheDir, input);
```

In `openAiProvider`, remove the `model` parameter and use input fields:

```ts
function openAiProvider(): RankerProvider {
```

Provider selection becomes:

```ts
const provider = options.provider ?? (process.env.OPENAI_API_KEY ? openAiProvider() : deterministicFallbackProvider);
```

Update OpenAI body:

```ts
        model: input.config.model,
        temperature: input.temperature,
        input: [
          { role: 'system', content: `You rank legal Fantasy Premier League backtest candidates. Return only JSON with candidateId and explanation. Strategy bias: ${input.config.promptBias}` },
          { role: 'user', content: JSON.stringify(compactRankerInput(input)) },
        ],
```

Update `compactRankerInput` to include config metadata:

```ts
    config: {
      id: input.config.id,
      preferDifferentials: input.config.preferDifferentials,
      newsSensitivity: input.config.newsSensitivity,
    },
    stochastic: input.stochastic,
    runId: input.runId,
```

Update candidate compact fields to include selected percentage:

```ts
      selectedByPercent: candidate.decision.startingXi
        .map(playerId => input.snapshot.knownBeforeDeadline.players.find(player => player.id === playerId)?.selectedByPercent ?? 0)
        .reduce((total, value) => total + value, 0),
```

Replace `rankerCachePath`:

```ts
function rankerCachePath(cacheDir: string, input: HybridRankerInput): string {
  const hash = createHash('sha256').update(JSON.stringify({ model: input.config.model, temperature: input.temperature, input: compactRankerInput(input) })).digest('hex').slice(0, 24);
  return join(cacheDir, 'ranker', `${input.snapshot.season}-gw${input.snapshot.gameweek}-${input.mode}-${input.configId}-${hash}.json`);
}
```

- [ ] **Step 5: Run focused tests**

Run: `npx tsx --test src/backtest/experiments/ranker.test.ts src/backtest/experiments/hybrid-strategy.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/backtest/experiments/hybrid-strategy.ts src/backtest/experiments/ranker.ts src/backtest/experiments/ranker.test.ts src/backtest/experiments/hybrid-strategy.test.ts
git commit -m "Pass experiment config to LLM ranker"
```

---

### Task 4: Separate Modes From Configs In Runner

**Files:**
- Modify: `src/backtest/experiments/runner.ts`
- Test: `src/backtest/experiments/runner.test.ts`

- [ ] **Step 1: Write failing runner option tests**

Update expected defaults in `parseExperimentOptions defaults to dry safe smoke matrix`:

```ts
    stochastic: false,
    runId: undefined,
```

Update expected values in `parseExperimentOptions accepts season list and LLM news opt in`:

```ts
    stochastic: false,
    runId: undefined,
```

Add test:

```ts
test('parseExperimentOptions accepts stochastic run id', () => {
  assert.deepEqual(parseExperimentOptions(['--stochastic', '--run-id=abc12345', '--max-configs=2']), {
    seasons: ['2021-2022', '2022-2023', '2023-2024', '2024-2025'],
    allowLlmNews: false,
    liveNews: false,
    cacheDir: 'data/experiments',
    maxConfigs: 2,
    stochastic: true,
    runId: 'abc12345',
  });
});
```

Update the `row` helper return object with new fields:

```ts
    model: 'test-model',
    temperature: 0,
    stochastic: false,
    choiceCounts: {},
    fallbackCount: 0,
```

Add summary telemetry assertion in `buildExperimentSummary aggregates averages and fair deltas`:

```ts
  assert.deepEqual(summary.rows[0]?.choiceCounts, {});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx --test src/backtest/experiments/runner.test.ts`

Expected: FAIL because `ExperimentOptions` and `ExperimentRow` lack stochastic/telemetry fields.

- [ ] **Step 3: Update runner types and parser**

In `src/backtest/experiments/runner.ts`, import config helpers:

```ts
import { createRunId, resolveTemperature, selectExperimentConfigs, type ExperimentConfig } from './configs.js';
```

Update `ExperimentOptions`:

```ts
export interface ExperimentOptions {
  seasons: string[];
  allowLlmNews: boolean;
  liveNews: boolean;
  cacheDir: string;
  maxConfigs: number;
  stochastic: boolean;
  runId?: string;
}
```

Update `ExperimentRow`:

```ts
  model: string;
  temperature: number;
  stochastic: boolean;
  runId?: string;
  choiceCounts: Record<string, number>;
  fallbackCount: number;
```

Update `parseExperimentOptions` return:

```ts
  const runIdArg = args.find(arg => arg.startsWith('--run-id='));
  const stochastic = args.includes('--stochastic');
  return {
    seasons: seasonsArg ? seasonsArg.split('=')[1]!.split(',').filter(Boolean) : DEFAULT_SEASONS,
    allowLlmNews: args.includes('--allow-llm-news'),
    liveNews: args.includes('--live-news'),
    cacheDir: cacheArg?.split('=')[1] ?? 'data/experiments',
    maxConfigs,
    stochastic,
    runId: runIdArg?.split('=')[1] ?? (stochastic ? createRunId() : undefined),
  };
```

- [ ] **Step 4: Update matrix execution loops**

Replace `runExperimentMatrix` mode/config loop:

```ts
export async function runExperimentMatrix(options: ExperimentOptions): Promise<ExperimentSummary> {
  const llmModes: NewsMode[] = options.allowLlmNews ? ['llm-news-strict', 'llm-news-loose'] : [];
  const configs = selectExperimentConfigs(options.maxConfigs);
  const rows: ExperimentRow[] = [];
  for (const season of options.seasons) {
    rows.push(await runExperimentSeason(season, 'fair', undefined, options));
    for (const mode of llmModes) {
      for (const config of configs) rows.push(await runExperimentSeason(season, mode, config, options));
    }
  }
  const summary = buildExperimentSummary(rows);
  await mkdir(options.cacheDir, { recursive: true });
  await writeFile(join(options.cacheDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
```

Replace `runExperimentSeason` signature and strategy setup:

```ts
async function runExperimentSeason(season: string, mode: ExperimentMode, config: ExperimentConfig | undefined, options: ExperimentOptions): Promise<ExperimentRow> {
  const snapshotStore = new FileSnapshotStore(getDefaultBacktestCacheDir(season));
  const firstSnapshot = await snapshotStore.getSnapshot(1);
  const warnings: string[] = [];
  const temperature = config ? resolveTemperature(config, options.stochastic) : 0;
  const strategy = mode === 'fair' || !config
    ? createFairStrategy()
    : createHybridStrategy({
      mode,
      config,
      temperature,
      stochastic: options.stochastic,
      runId: options.runId,
      ranker: createCachedRanker({ cacheDir: options.cacheDir }),
      getNews: async ({ snapshot }) => {
        if (!options.liveNews) {
          warnings.push(`${season} GW${snapshot.gameweek}: Live news disabled; run with --live-news to fetch historical articles.`);
          return [];
        }
        const context = await getNewsContext({ cacheDir: join(options.cacheDir, 'news'), season, gameweek: snapshot.gameweek, deadline: snapshot.deadline, mode });
        warnings.push(...context.warnings.map(warning => `${season} GW${snapshot.gameweek}: ${warning}`));
        return context.items;
      },
    });
```

Update returned row fields:

```ts
    configId: mode === 'fair' ? 'fair-default' : config!.id,
    model: config?.model ?? 'deterministic-fair',
    temperature,
    stochastic: options.stochastic,
    runId: options.runId,
    choiceCounts: summarizeChoiceCounts(state.decisions),
    fallbackCount: countFallbacks(state.decisions),
```

Add helpers near the bottom:

```ts
function summarizeChoiceCounts(decisions: Array<{ notes: string[] }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const decision of decisions) {
    const note = decision.notes.find(value => value.startsWith('LLM hybrid selected '));
    if (!note) continue;
    const candidateId = note.slice('LLM hybrid selected '.length).split(':')[0] ?? 'unknown';
    const prefix = candidateId.split('-')[0] ?? candidateId;
    counts[prefix] = (counts[prefix] ?? 0) + 1;
  }
  return counts;
}

function countFallbacks(decisions: Array<{ notes: string[] }>): number {
  return decisions.flatMap(decision => decision.notes).filter(note => /fallback|no llm provider|provider failed|invalid candidate/i.test(note)).length;
}
```

- [ ] **Step 5: Update formatted summary for stochastic run id**

Update `formatExperimentSummary`:

```ts
export function formatExperimentSummary(summary: ExperimentSummary): string {
  const runIds = [...new Set(summary.rows.map(row => row.runId).filter(Boolean))];
  return [
    'Experiment summary',
    ...runIds.map(runId => `stochastic run id: ${runId}`),
    ...summary.configs.map(config => `${config.mode}/${config.configId}: ${config.averagePoints.toFixed(1)} avg points`),
  ].join('\n');
}
```

- [ ] **Step 6: Run runner tests**

Run: `npx tsx --test src/backtest/experiments/runner.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/backtest/experiments/runner.ts src/backtest/experiments/runner.test.ts
git commit -m "Run experiment configs across news modes"
```

---

### Task 5: Add Choice Telemetry To Ranker Cache Results

**Files:**
- Modify: `src/backtest/experiments/ranker.ts`
- Test: `src/backtest/experiments/ranker.test.ts`

- [ ] **Step 1: Write failing fallback telemetry test**

In `src/backtest/experiments/ranker.test.ts`, add:

```ts
test('createCachedRanker preserves fallback explanations for report telemetry', async () => {
  await withTempDir(async cacheDir => {
    const ranker = createCachedRanker({
      cacheDir,
      provider: async () => ({ candidateId: 'missing', explanation: 'bad choice' }),
    });

    const result = await ranker(rankerInput());

    assert.equal(result.candidateId, 'best-transfer');
    assert.match(result.explanation, /provider returned invalid candidate missing/i);
  });
});
```

- [ ] **Step 2: Run test**

Run: `npx tsx --test src/backtest/experiments/ranker.test.ts`

Expected: PASS if existing fallback text already satisfies the requirement. If it fails because the explanation changed in Task 3, restore the exact fallback phrase in `validateSelection`.

- [ ] **Step 3: Verify cache file includes explanation**

Run: `npx tsx --test src/backtest/experiments/ranker.test.ts`

Expected: PASS and no extra source changes beyond the test unless Step 2 required a text restoration.

- [ ] **Step 4: Commit**

```bash
git add src/backtest/experiments/ranker.ts src/backtest/experiments/ranker.test.ts
git commit -m "Cover ranker fallback telemetry"
```

---

### Task 6: Verify End-To-End Variation

**Files:**
- No source changes expected unless verification exposes a bug.

- [ ] **Step 1: Run full unit tests**

Run: `npm test`

Expected: PASS, all tests green.

- [ ] **Step 2: Run build**

Run: `npm run build`

Expected: PASS, TypeScript exits 0.

- [ ] **Step 3: Run deterministic experiment smoke without live costs**

Run: `npm run backtest:experiment -- --seasons=2023-2024 --allow-llm-news --max-configs=2 --cache-dir=/tmp/opencode/fpl-exp-variation-deterministic`

Expected: summary includes fair plus `balanced` and `aggressive` configs for both strict and loose modes. Scores may match if no API key is configured, but `choiceCounts` and `fallbackCount` must appear in JSON rows.

- [ ] **Step 4: Run stochastic cached smoke with live LLM only if key is available**

First check key availability without printing it:

Run: `set -a; source /home/emmanuel/fpl-agent/.env; set +a; node -e "console.log(process.env.OPENAI_API_KEY ? 'set' : 'unset')"`

Expected: `set` to continue. If `unset`, skip this step and record that live stochastic verification was not run.

If key is set, run:

```bash
set -a; source /home/emmanuel/fpl-agent/.env; set +a; npm run backtest:experiment -- --seasons=2023-2024 --allow-llm-news --max-configs=2 --stochastic --run-id=smoke001 --cache-dir=/tmp/opencode/fpl-exp-variation-stochastic-smoke001
```

Expected: summary prints `stochastic run id: smoke001`; ranker cache files include real LLM explanations or explicit fallback explanations.

- [ ] **Step 5: Inspect choice counts**

Run: `node -e "const s=require('/tmp/opencode/fpl-exp-variation-deterministic/summary.json'); console.log(s.rows.map(r=>({mode:r.mode,configId:r.configId,points:r.totalPoints,choiceCounts:r.choiceCounts,fallbackCount:r.fallbackCount})))"`

Expected: rows show candidate choice counts. At least one LLM row should include transfer or hold counts.

- [ ] **Step 6: Commit any verification fixes**

If source fixes were needed during verification:

```bash
git add src/backtest/experiments
git commit -m "Fix experiment variation verification issues"
```

If no source fixes were needed, do not create an empty commit.

---

## Plan Self-Review

Spec coverage:

- Reproducible configs: Task 1 and Task 4.
- Explicit stochastic flag/run id: Task 3 and Task 4.
- Broader candidate slate: Task 2.
- Ranker prompt/cache metadata: Task 3.
- Reporting choice/fallback telemetry: Task 4 and Task 5.
- Tests and verification: Tasks 1 through 6.

Placeholder scan:

- No `TBD`, `TODO`, or open-ended implementation placeholders remain.
- Each task has exact files, code snippets, commands, expected results, and commit commands.

Type consistency:

- `ExperimentConfig`, `HybridRankerInput`, `ExperimentOptions`, and `ExperimentRow` fields are introduced before use.
- `configId` remains string-compatible for existing summary aggregation.
