// Decision Engine for Autonomous Mode
// Includes intelligence gathering for late news and player updates
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';
import { savePlayerNewsSignals } from '../db/client.js';
import { getRunnerTimingConfig, getSafetyLimits, validateTransfer, validateChip, resetWeeklyTransfers } from './limits.js';
import { gatherFPLNewsWithHealth, type NewsFeedHealth, type NewsItem } from './news.js';
import type { Gameweek, Player, MyTeam } from '../api/types.js';
import type { TeamSelection } from '../api/client.js';
import {
  calculateOwnershipUtility,
  deriveRankPolicy,
  type RankPolicy,
} from '../strategy/rank-policy.js';
import {
  buildExternalNewsSignals,
  buildOfficialNewsSignals,
  mergePlayerNewsSignals,
  type PlayerNewsSignal,
} from './news-signals.js';

export interface TransferCandidate {
  playerOut: Player;
  playerIn: Player;
  xpGain: number;
  hitCost: number;
  netGain: number;
  confidence: number;
  reasoning: string;
  priceRisk: 'rising' | 'falling' | 'stable';
  sellingPrice: number;
  purchasePrice?: number;
}

export interface OptimizedTransferPlan {
  transfers: TransferCandidate[];
  expectedGain: number;
  hitCost: number;
  netGain: number;
  templateProtectionGain: number;
  rankUtilityGain: number;
  objectiveGain: number;
  confidence: number;
  horizon: number;
  mode: 'incremental' | 'unlimited-rebuild';
  targetPlayerIds: number[];
  blockedReason?: string;
}

export interface TeamHealth {
  injuries: { player: Player; status: string; chance: number }[];
  suspensions: Player[];
  blankingPlayers: Player[];
  doubts: Player[];
  alerts: string[];
}

export interface OptimalLineup {
  selection: TeamSelection[];
  startingXI: Player[];
  bench: Player[];
  captain: Player;
  viceCaptain: Player;
  captainExpectedPoints: number;
  expectedPoints: number;
  confidence: number;
}

export interface DecisionContext {
  season: string;
  managerId: number;
  gameweek: number;
  deadline: Date | null;
  hoursToDeadline: number;
  isPreDeadline: boolean;
  myTeam: MyTeam | null;
  freeTransfers: number;
  bank: number;
  teamHealth: TeamHealth;
  playerStatusChanges: { player: Player; oldStatus: string; newStatus: string }[];
  newsAlerts: string[];
  externalNews: NewsItem[];
  newsSignals: PlayerNewsSignal[];
  intelligenceFeed: NewsFeedHealth;
  rankPolicy: RankPolicy;
}

export function getFreeTransfers(myTeam: MyTeam): number {
  if (hasUnlimitedTransfers(myTeam)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(0, (myTeam.transfers.limit ?? 0) - myTeam.transfers.made);
}

export function hasUnlimitedTransfers(myTeam: Pick<MyTeam, 'transfers'>): boolean {
  return myTeam.transfers.status === 'unlimited';
}

export type UnlimitedTransferReason = 'preseason' | 'wildcard' | 'freehit' | 'unknown' | null;

export function getUnlimitedTransferReason(
  myTeam: Pick<MyTeam, 'transfers' | 'chips'>,
  gameweeks: Pick<Gameweek, 'finished'>[] = []
): UnlimitedTransferReason {
  if (!hasUnlimitedTransfers(myTeam)) return null;
  const activeTransferChip = myTeam.chips.find(chip =>
    (chip.status_for_entry === 'active' || chip.is_pending === true)
    && (chip.name === 'wildcard' || chip.name === 'freehit')
  );
  if (activeTransferChip?.name === 'wildcard') return 'wildcard';
  if (activeTransferChip?.name === 'freehit') return 'freehit';
  if (gameweeks.length > 0 && gameweeks.every(gameweek => gameweek.finished !== true)) {
    return 'preseason';
  }
  return 'unknown';
}

export function getTransferPlanningHorizon(
  myTeam: Pick<MyTeam, 'transfers'>,
  requestedHorizon: number,
  reason: UnlimitedTransferReason = hasUnlimitedTransfers(myTeam) ? 'unknown' : null
): number {
  if (!hasUnlimitedTransfers(myTeam)) return requestedHorizon;
  if (reason === 'freehit') return 1;
  if (reason === 'wildcard') return requestedHorizon;
  if (reason === 'preseason') return Math.min(requestedHorizon, 3);
  return 1;
}

export function getActiveLineupChip(myTeam: MyTeam): 'bboost' | '3xc' | null {
  const active = myTeam.chips.find(chip =>
    (chip.status_for_entry === 'active' || chip.is_pending === true)
    && (chip.name === 'bboost' || chip.name === '3xc')
  );
  return active?.name as 'bboost' | '3xc' | undefined ?? null;
}

// Cache for detecting player status changes (late news)
const playerStatusCache = new Map<number, string>();
const previousRankModeByManager = new Map<number, RankPolicy['mode']>();

export function getConfiguredTargetRank(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = env.FPL_TARGET_RANK?.trim() || '100000';
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Gather intelligence on player status changes since last check
 * This catches late news like injuries, doubts, suspensions
 */
export async function gatherIntelligence(gameweek?: number, deadline?: Date): Promise<{
  statusChanges: { player: Player; oldStatus: string; newStatus: string }[];
  priceChanges: { player: Player; direction: 'up' | 'down'; amount: number }[];
  newsAlerts: string[];
  externalNews: NewsItem[];
  newsSignals: PlayerNewsSignal[];
  intelligenceFeed: NewsFeedHealth;
}> {
  const engine = await getOptimizationEngine();
  const allPlayers = engine.getAllPlayers();
  
  const statusChanges: { player: Player; oldStatus: string; newStatus: string }[] = [];
  const priceChanges: { player: Player; direction: 'up' | 'down'; amount: number }[] = [];
  const newsAlerts: string[] = [];
  
  for (const player of allPlayers) {
    // Check status changes (injuries, suspensions, doubts)
    const cachedStatus = playerStatusCache.get(player.id);
    const currentStatus = player.status;
    
    if (cachedStatus && cachedStatus !== currentStatus) {
      statusChanges.push({
        player,
        oldStatus: cachedStatus,
        newStatus: currentStatus,
      });
      
      // Generate alert for significant changes
      if (currentStatus === 'i' || currentStatus === 's') {
        newsAlerts.push(`ALERT: ${player.web_name} now ${currentStatus === 'i' ? 'injured' : 'suspended'}`);
      } else if (cachedStatus === 'i' && currentStatus === 'a') {
        newsAlerts.push(`GOOD NEWS: ${player.web_name} recovered from injury`);
      }
    }
    
    // Update cache
    playerStatusCache.set(player.id, currentStatus);
    
    // Check price changes
    if (player.cost_change_event !== 0) {
      priceChanges.push({
        player,
        direction: player.cost_change_event > 0 ? 'up' : 'down',
        amount: Math.abs(player.cost_change_event),
      });
    }
  }
  
  // Check for news via player news field
  const playersWithNews = allPlayers.filter(p => p.news && p.news.length > 0);
  for (const player of playersWithNews.slice(0, 10)) {
    if (player.chance_of_playing_next_round !== null && player.chance_of_playing_next_round < 75) {
      newsAlerts.push(`${player.web_name}: ${player.news} (${player.chance_of_playing_next_round}% chance)`);
    }
  }
  
  // Gather external news from Twitter and FPL websites
  const gatheredNews = await gatherFPLNewsWithHealth();
  const externalNews = gatheredNews.items;
  const targetGameweek = gameweek ?? engine.getNextDeadline()?.gameweek ?? engine.getCurrentGameweek();
  const targetDeadline = deadline ?? engine.getNextDeadline()?.deadline ?? new Date(Date.now() + 7 * 86_400_000);
  const newsSignals = mergePlayerNewsSignals([
    ...buildOfficialNewsSignals(allPlayers, targetGameweek, targetDeadline),
    ...buildExternalNewsSignals({ items: externalNews, players: allPlayers, gameweek: targetGameweek, deadline: targetDeadline }),
  ]);
  engine.setNewsSignals(newsSignals);
  await savePlayerNewsSignals(engine.getSeasonConfig().season, newsSignals);
  
  // Add high priority news to alerts
  for (const news of externalNews.filter(n => n.priority === 'high')) {
    newsAlerts.push(`BREAKING: ${news.title.substring(0, 100)}`);
  }
  
  return {
    statusChanges,
    priceChanges,
    newsAlerts,
    externalNews,
    newsSignals,
    intelligenceFeed: gatheredNews.feedHealth,
  };
}

/**
 * Analyze team health - injuries, doubts, blanks
 */
export async function analyzeTeamHealth(myTeam: MyTeam): Promise<TeamHealth> {
  const engine = await getOptimizationEngine();
  const currentGW = engine.getCurrentGameweek();
  
  const injuries: TeamHealth['injuries'] = [];
  const suspensions: Player[] = [];
  const blankingPlayers: Player[] = [];
  const doubts: Player[] = [];
  const alerts: string[] = [];
  
  for (const pick of myTeam.picks) {
    const player = engine.getPlayer(pick.element);
    if (!player) continue;
    
    // Check status
    switch (player.status) {
      case 'i': // Injured
        injuries.push({
          player,
          status: player.news || 'Injured',
          chance: player.chance_of_playing_next_round ?? 0,
        });
        break;
      case 's': // Suspended
        suspensions.push(player);
        break;
      case 'd': // Doubtful
        doubts.push(player);
        if (player.chance_of_playing_next_round !== null && player.chance_of_playing_next_round < 50) {
          alerts.push(`${player.web_name} doubtful (${player.chance_of_playing_next_round}%)`);
        }
        break;
    }
    
    // Check for blank gameweek (no fixture)
    const upcomingFixtures = engine.getUpcomingFixtures(player.team, 1);
    if (upcomingFixtures.length === 0) {
      blankingPlayers.push(player);
    }
  }
  
  return { injuries, suspensions, blankingPlayers, doubts, alerts };
}

/**
 * Find best transfer candidates based on game theory
 */
export async function findBestTransfers(
  myTeam: MyTeam,
  maxCandidates: number = 5
): Promise<TransferCandidate[]> {
  const engine = await getOptimizationEngine();
  const freeTransfers = getFreeTransfers(myTeam);
  const bank = myTeam.transfers.bank;
  const sellingPrices = new Map(myTeam.picks.map(p => [p.element, p.selling_price]));
  const purchasePrices = new Map(myTeam.picks.map(p => [p.element, p.purchase_price]));
  
  const candidates: TransferCandidate[] = [];
  const squadPlayerIds = myTeam.picks.map(p => p.element);
  const squadTeamCounts = new Map<number, number>();
  for (const playerId of squadPlayerIds) {
    const player = engine.getPlayer(playerId);
    if (player) squadTeamCounts.set(player.team, (squadTeamCounts.get(player.team) ?? 0) + 1);
  }
  
  // Get players to potentially sell (starting XI with issues or low xP)
  const sellCandidates: Player[] = [];
  for (const pick of myTeam.picks.slice(0, 11)) { // Focus on starting XI
    const player = engine.getPlayer(pick.element);
    if (!player) continue;
    
    // Consider selling if: injured, suspended, doubtful, or low form
    if (player.status !== 'a' || parseFloat(player.form) < 3) {
      sellCandidates.push(player);
    }
  }
  
  // Also consider lowest xP player in starting XI
  const startingXIWithXP = myTeam.picks.slice(0, 11)
    .map(p => ({
      player: engine.getPlayer(p.element)!,
      xp: engine.calculateExpectedPoints(p.element, 5),
    }))
    .filter(x => x.player)
    .sort((a, b) => a.xp.next5GW - b.xp.next5GW);
  
  if (startingXIWithXP.length > 0 && !sellCandidates.includes(startingXIWithXP[0].player)) {
    sellCandidates.push(startingXIWithXP[0].player);
  }
  
  // For each sell candidate, find best replacement
  for (const playerOut of sellCandidates) {
    const sellingPrice = sellingPrices.get(playerOut.id) ?? playerOut.now_cost;
    const maxPrice = sellingPrice + bank;
    const position = playerOut.element_type;
    
    // Get all available players in same position
    const allPlayers = engine.getAllPlayers();
    const replacements = allPlayers
      .filter(p => 
        p.element_type === position &&
        p.now_cost <= maxPrice &&
        p.status === 'a' &&
        p.can_select !== false &&
        p.can_transact !== false &&
        p.removed !== true &&
        !squadPlayerIds.includes(p.id) &&
        p.id !== playerOut.id &&
        (squadTeamCounts.get(p.team) ?? 0) - (p.team === playerOut.team ? 1 : 0) < 3
      )
      .map(p => ({
        player: p,
        xp: engine.calculateExpectedPoints(p.id, 5),
        priceChange: engine.predictPriceChange(p.id),
      }))
      .sort((a, b) => b.xp.next5GW - a.xp.next5GW)
      .slice(0, 3); // Top 3 per position
    
    // Evaluate each replacement
    for (const replacement of replacements) {
      const evaluation = engine.evaluateTransfer(
        playerOut.id,
        replacement.player.id,
        freeTransfers,
        5
      );
      
      if (evaluation.netGain > 0) {
        candidates.push({
          playerOut,
          playerIn: replacement.player,
          xpGain: evaluation.xpGain,
          hitCost: evaluation.hitCost,
          netGain: evaluation.netGain,
          confidence: evaluation.confidence,
          reasoning: evaluation.reasoning,
          priceRisk: replacement.priceChange.prediction === 'rise'
            ? 'rising'
            : replacement.priceChange.prediction === 'fall'
              ? 'falling'
              : 'stable',
          sellingPrice,
          purchasePrice: purchasePrices.get(playerOut.id),
        });
      }
    }
  }
  
  // Sort by net gain and return top candidates
  return candidates
    .sort((a, b) => b.netGain - a.netGain)
    .slice(0, maxCandidates);
}

const SQUAD_POSITION_COUNTS = new Map<number, number>([[1, 2], [2, 5], [3, 5], [4, 3]]);
const UNLIMITED_REBUILD_BEAM_WIDTH = 6_000;

export interface UnlimitedSquadCandidate {
  player: Player;
  cost: number;
  projectedValue: number;
  ownership: number;
  templateProtectionBonus?: number;
  ownershipUtility: number;
  currentlyOwned: boolean;
  templateCore?: boolean;
  requiredAnchor?: boolean;
}

export interface UnlimitedSquadConstraints {
  minimumTemplateCorePlayers?: number;
  requireTemplateAnchor?: boolean;
}

interface UnlimitedSquadState {
  selected: UnlimitedSquadCandidate[];
  cost: number;
  objective: number;
  clubCounts: Map<number, number>;
  lastCandidateIndex: number;
  templateCorePlayers: number;
  templateAnchors: number;
}

export function parseOfficialOwnership(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '');
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
}

export function calculateProtectTemplateBonus(
  ownershipPercent: number,
  horizon: number,
  weight: number
): number {
  if (![ownershipPercent, horizon, weight].every(Number.isFinite)) return 0;
  const ownershipRatio = Math.max(0, Math.min(100, ownershipPercent)) / 100;
  return Math.max(0, horizon) * Math.max(0, weight) * Math.sqrt(ownershipRatio);
}

export function shouldEnforceUnlimitedMarketFloor(
  policy: Pick<RankPolicy, 'mode' | 'fallback'>
): boolean {
  return policy.mode === 'protect'
    || (policy.mode === 'balanced' && policy.fallback === 'early-season');
}

export function isUnlimitedRebuildImprovement(expectedGain: number, objectiveGain: number): boolean {
  return Number.isFinite(expectedGain)
    && Number.isFinite(objectiveGain)
    && expectedGain >= 0
    && objectiveGain > 0;
}

export function getAtomicTransferConfidence(
  transfers: Pick<TransferCandidate, 'confidence'>[]
): number {
  return transfers.length > 0
    ? Math.min(...transfers.map(transfer => transfer.confidence))
    : 1;
}

/**
 * Build an atomic unlimited-transfer target from scratch. The beam follows the
 * exact 2/5/5/3 position slots and preserves cheap/enabler paths so a premium
 * purchase is not rejected merely because it cannot be funded in one move.
 */
export function buildUnlimitedSquad(
  candidates: UnlimitedSquadCandidate[],
  budget: number,
  maxPlayersPerClub: number = 3,
  scoreCompleteSquad?: (squad: UnlimitedSquadCandidate[], bank: number) => number,
  constraints: UnlimitedSquadConstraints = {}
): UnlimitedSquadCandidate[] | null {
  if (!Number.isFinite(budget) || budget < 0 || !Number.isInteger(maxPlayersPerClub) || maxPlayersPerClub < 1) {
    return null;
  }
  const minimumTemplateCorePlayers = constraints.minimumTemplateCorePlayers ?? 0;
  if (!Number.isInteger(minimumTemplateCorePlayers) || minimumTemplateCorePlayers < 0) return null;
  const legalCandidates = candidates.filter(candidate =>
    SQUAD_POSITION_COUNTS.has(candidate.player.element_type)
    && Number.isFinite(candidate.cost)
    && candidate.cost > 0
  );
  if (legalCandidates.filter(candidate => candidate.templateCore).length < minimumTemplateCorePlayers) {
    return null;
  }
  if (constraints.requireTemplateAnchor && !legalCandidates.some(candidate => candidate.requiredAnchor)) {
    return null;
  }

  const pools = new Map<number, UnlimitedSquadCandidate[]>();
  for (const [position, required] of SQUAD_POSITION_COUNTS) {
    const positionCandidates = candidates.filter(candidate =>
      candidate.player.element_type === position
      && Number.isFinite(candidate.cost)
      && candidate.cost > 0
    );
    const selected = new Map<number, UnlimitedSquadCandidate>();
    const add = (values: UnlimitedSquadCandidate[]) => {
      for (const candidate of values) selected.set(candidate.player.id, candidate);
    };
    add(positionCandidates.filter(candidate => candidate.requiredAnchor));
    add(positionCandidates.filter(candidate => candidate.currentlyOwned));
    const corePoolSize = Math.max(required, minimumTemplateCorePlayers);
    add([...positionCandidates]
      .filter(candidate => candidate.templateCore)
      .sort((left, right) => candidateObjective(right) - candidateObjective(left) || left.player.id - right.player.id)
      .slice(0, corePoolSize));
    add([...positionCandidates]
      .filter(candidate => candidate.templateCore)
      .sort((left, right) => left.cost - right.cost || candidateObjective(right) - candidateObjective(left) || left.player.id - right.player.id)
      .slice(0, corePoolSize));
    add([...positionCandidates]
      .sort((left, right) => candidateObjective(right) - candidateObjective(left) || left.player.id - right.player.id)
      .slice(0, 14));
    add([...positionCandidates]
      .sort((left, right) => candidateValuePerCost(right) - candidateValuePerCost(left) || left.player.id - right.player.id)
      .slice(0, 8));
    add([...positionCandidates]
      .sort((left, right) => right.ownership - left.ownership || left.player.id - right.player.id)
      .slice(0, 8));
    add([...positionCandidates]
      .sort((left, right) => left.cost - right.cost || candidateObjective(right) - candidateObjective(left) || left.player.id - right.player.id)
      .slice(0, 4));
    const pool = [...selected.values()].sort((left, right) => left.player.id - right.player.id);
    if (pool.length < required) return null;
    pools.set(position, pool);
  }

  // Resolve scarce premium/captain structure before the defensive and
  // goalkeeper enablers. A goalkeeper-first beam can spend the budget before
  // it ever evaluates the required high-ownership attacking anchor.
  const slots = [4, 3, 2, 1]
    .flatMap(position => Array.from({ length: SQUAD_POSITION_COUNTS.get(position)! }, () => position));
  let beam: UnlimitedSquadState[] = [{
    selected: [],
    cost: 0,
    objective: 0,
    clubCounts: new Map(),
    lastCandidateIndex: -1,
    templateCorePlayers: 0,
    templateAnchors: 0,
  }];

  for (let slotIndex = 0; slotIndex < slots.length; slotIndex++) {
    const position = slots[slotIndex]!;
    const samePosition = slotIndex > 0 && slots[slotIndex - 1] === position;
    const pool = pools.get(position)!;
    const expanded: UnlimitedSquadState[] = [];

    for (const state of beam) {
      const startIndex = samePosition ? state.lastCandidateIndex + 1 : 0;
      for (let candidateIndex = startIndex; candidateIndex < pool.length; candidateIndex++) {
        const candidate = pool[candidateIndex]!;
        const currentClubCount = state.clubCounts.get(candidate.player.team) ?? 0;
        if (currentClubCount >= maxPlayersPerClub) continue;
        const nextCost = state.cost + candidate.cost;
        if (nextCost > budget) continue;
        const optimisticCost = optimisticRemainingCost(
          slots.slice(slotIndex + 1),
          pools,
          position,
          candidateIndex
        );
        if (!Number.isFinite(optimisticCost) || nextCost + optimisticCost > budget) continue;

        const clubCounts = new Map(state.clubCounts);
        clubCounts.set(candidate.player.team, currentClubCount + 1);
        expanded.push({
          selected: [...state.selected, candidate],
          cost: nextCost,
          objective: state.objective + candidateObjective(candidate),
          clubCounts,
          lastCandidateIndex: candidateIndex,
          templateCorePlayers: state.templateCorePlayers + (candidate.templateCore ? 1 : 0),
          templateAnchors: state.templateAnchors + (candidate.requiredAnchor ? 1 : 0),
        });
      }
    }

    if (expanded.length === 0) return null;
    beam = pruneUnlimitedSquadBeam(expanded, UNLIMITED_REBUILD_BEAM_WIDTH);
  }

  const complete = beam.filter(state =>
    state.selected.length === 15
    && state.cost <= budget
    && state.templateCorePlayers >= minimumTemplateCorePlayers
    && (!constraints.requireTemplateAnchor || state.templateAnchors >= 1)
  );
  if (complete.length === 0) return null;
  complete.sort((left, right) => {
    const leftScore = scoreCompleteSquad?.(left.selected, budget - left.cost) ?? left.objective;
    const rightScore = scoreCompleteSquad?.(right.selected, budget - right.cost) ?? right.objective;
    return rightScore - leftScore
      || right.objective - left.objective
      || left.cost - right.cost
      || compareCandidateIds(left.selected, right.selected);
  });
  return complete[0]!.selected;
}

function candidateObjective(candidate: UnlimitedSquadCandidate): number {
  return candidate.projectedValue
    + (candidate.templateProtectionBonus ?? 0)
    + candidate.ownershipUtility;
}

function candidateValuePerCost(candidate: UnlimitedSquadCandidate): number {
  return candidate.cost > 0 ? candidateObjective(candidate) / candidate.cost : 0;
}

function optimisticRemainingCost(
  remainingSlots: number[],
  pools: Map<number, UnlimitedSquadCandidate[]>,
  currentPosition: number,
  currentCandidateIndex: number
): number {
  const required = new Map<number, number>();
  for (const position of remainingSlots) required.set(position, (required.get(position) ?? 0) + 1);
  let total = 0;
  for (const [position, count] of required) {
    const pool = pools.get(position) ?? [];
    const available = position === currentPosition ? pool.slice(currentCandidateIndex + 1) : pool;
    if (available.length < count) return Number.POSITIVE_INFINITY;
    total += [...available]
      .sort((left, right) => left.cost - right.cost || left.player.id - right.player.id)
      .slice(0, count)
      .reduce((sum, candidate) => sum + candidate.cost, 0);
  }
  return total;
}

function pruneUnlimitedSquadBeam(states: UnlimitedSquadState[], width: number): UnlimitedSquadState[] {
  const byObjective = [...states].sort(compareUnlimitedStates);
  if (byObjective.length <= width) return byObjective;

  const requirementGroups = new Map<string, UnlimitedSquadState[]>();
  for (const state of byObjective) {
    const key = `${state.templateCorePlayers}|${state.templateAnchors}`;
    requirementGroups.set(key, [...(requirementGroups.get(key) ?? []), state]);
  }
  const perRequirementGroup = Math.max(40, Math.floor(width * 0.4 / requirementGroups.size));
  const requirementDiversity = [...requirementGroups.values()]
    .flatMap(group => group.slice(0, perRequirementGroup));

  const bucketLeaders = new Map<string, UnlimitedSquadState>();
  for (const state of byObjective) {
    const incomingCount = state.selected.filter(candidate => !candidate.currentlyOwned).length;
    const constrainedClubs = [...state.clubCounts.entries()]
      .filter(([, count]) => count >= 2)
      .sort(([left], [right]) => left - right)
      .map(([club, count]) => `${club}:${count}`)
      .join(',');
    const key = `${Math.floor(state.cost / 5)}|${incomingCount}|${state.templateCorePlayers}|${state.templateAnchors}|${constrainedClubs}`;
    if (!bucketLeaders.has(key)) bucketLeaders.set(key, state);
  }

  const preferred = [
    ...requirementDiversity,
    ...byObjective.slice(0, Math.floor(width * 0.45)),
    ...[...bucketLeaders.values()].sort(compareUnlimitedStates).slice(0, Math.floor(width * 0.2)),
    ...[...states]
      .sort((left, right) => left.cost - right.cost || compareUnlimitedStates(left, right))
      .slice(0, Math.ceil(width * 0.2)),
  ];
  const unique = new Map<string, UnlimitedSquadState>();
  for (const state of preferred) {
    const key = state.selected.map(candidate => candidate.player.id).join(',');
    if (!unique.has(key)) unique.set(key, state);
    if (unique.size === width) break;
  }
  if (unique.size < width) {
    for (const state of byObjective) {
      const key = state.selected.map(candidate => candidate.player.id).join(',');
      if (!unique.has(key)) unique.set(key, state);
      if (unique.size === width) break;
    }
  }
  return [...unique.values()];
}

function compareUnlimitedStates(left: UnlimitedSquadState, right: UnlimitedSquadState): number {
  return right.objective - left.objective
    || left.cost - right.cost
    || compareCandidateIds(left.selected, right.selected);
}

function compareCandidateIds(left: UnlimitedSquadCandidate[], right: UnlimitedSquadCandidate[]): number {
  const leftIds = left.map(candidate => candidate.player.id);
  const rightIds = right.map(candidate => candidate.player.id);
  for (let index = 0; index < Math.min(leftIds.length, rightIds.length); index++) {
    if (leftIds[index] !== rightIds[index]) return leftIds[index]! - rightIds[index]!;
  }
  return leftIds.length - rightIds.length;
}

export async function optimizeTransferPlan(
  myTeam: MyTeam,
  maximumTransfers: number,
  horizon: number = 6,
  rankPolicy?: RankPolicy
): Promise<OptimizedTransferPlan> {
  // Unlimited periods have different semantics: Free Hit is one week,
  // Wildcard is a permanent rebuild, and preseason uses a cautious short
  // horizon while roles are still uncertain.
  const engine = await getOptimizationEngine();
  const unlimitedReason = getUnlimitedTransferReason(myTeam, engine.getGameweeks());
  horizon = getTransferPlanningHorizon(myTeam, horizon, unlimitedReason);
  const limits = getSafetyLimits();
  const activeRankPolicy = rankPolicy ?? deriveRankPolicy({
    gameweek: engine.getNextDeadline()?.gameweek ?? engine.getCurrentGameweek(),
    overallRank: null,
    targetRank: null,
  });
  const freeTransfers = getFreeTransfers(myTeam);
  const originalIds = new Set(myTeam.picks.map(pick => pick.element));
  const projections = new Map<number, ReturnType<typeof engine.calculateExpectedPoints>>();
  const projectedValue = (playerId: number) => {
    let projection = projections.get(playerId);
    if (!projection) {
      projection = engine.calculateExpectedPoints(playerId, horizon);
      projections.set(playerId, projection);
    }
    return projection.next5GW * (0.8 + projection.confidence * 0.2);
  };
  const ownership = (player: Player) => parseOfficialOwnership(player.selected_by_percent);
  const selectablePlayers = engine.getAllPlayers().filter(player =>
    player.can_select !== false
    && player.can_transact !== false
    && player.removed !== true
  );
  const referenceByPosition = new Map<number, Player>();
  for (const player of selectablePlayers) {
    const current = referenceByPosition.get(player.element_type);
    if (!current || projectedValue(player.id) > projectedValue(current.id)) {
      referenceByPosition.set(player.element_type, player);
    }
  }
  const horizonDistribution = (playerId: number) => {
    const projection = projections.get(playerId) ?? engine.calculateExpectedPoints(playerId, horizon);
    projections.set(playerId, projection);
    const spread = Math.sqrt(Math.max(1, projection.next5GW)) * (1.25 + (1 - projection.confidence) * 0.75);
    return {
      projection,
      p10: Math.max(0, projection.next5GW - spread * 1.28),
      p90: projection.next5GW + spread * 1.28,
    };
  };
  const ownershipUtility = (player: Player): number => {
    const reference = referenceByPosition.get(player.element_type);
    if (!reference || reference.id === player.id) return 0;
    const candidate = horizonDistribution(player.id);
    const baseline = horizonDistribution(reference.id);
    return calculateOwnershipUtility(activeRankPolicy, {
      expectedPoints: candidate.projection.next5GW,
      referenceExpectedPoints: baseline.projection.next5GW,
      startProbability: candidate.projection.availability.startProbability,
      effectiveOwnershipPercent: ownership(player),
      referenceEffectiveOwnershipPercent: ownership(reference),
      p10Points: candidate.p10,
      referenceP10Points: baseline.p10,
      p90Points: candidate.p90,
      referenceP90Points: baseline.p90,
    }).utility;
  };
  const templateProtectionBonus = (player: Player): number => shouldEnforceUnlimitedMarketFloor(activeRankPolicy)
    ? calculateProtectTemplateBonus(ownership(player), horizon, limits.protectTemplateWeight)
    : 0;

  type SquadEntry = { player: Player; sellingPrice: number; purchasePrice: number };
  type SearchState = {
    squad: Map<number, SquadEntry>;
    bank: number;
    transfers: TransferCandidate[];
    usedOut: Set<number>;
    score: number;
  };

  const currentTargetIds = [...originalIds].sort((left, right) => left - right);
  const emptyPlan = (
    mode: OptimizedTransferPlan['mode'],
    blockedReason?: string
  ): OptimizedTransferPlan => ({
    transfers: [],
    expectedGain: 0,
    hitCost: 0,
    netGain: 0,
    templateProtectionGain: 0,
    rankUtilityGain: 0,
    objectiveGain: 0,
    confidence: 1,
    horizon,
    mode,
    targetPlayerIds: currentTargetIds,
    ...(blockedReason ? { blockedReason } : {}),
  });

  const initialSquad = new Map<number, SquadEntry>();
  for (const pick of myTeam.picks) {
    const player = engine.getPlayer(pick.element);
    if (player) initialSquad.set(player.id, {
      player,
      sellingPrice: pick.selling_price ?? player.now_cost,
      purchasePrice: pick.purchase_price ?? pick.selling_price ?? player.now_cost,
    });
  }
  if (initialSquad.size !== 15) throw new Error('Cannot optimize an incomplete squad');
  if (hasUnlimitedTransfers(myTeam) && unlimitedReason === 'unknown') {
    return emptyPlan(
      'unlimited-rebuild',
      'Unlimited transfer status is present but cannot be identified as preseason, Wildcard, or Free Hit'
    );
  }

  const scoreSquad = (squad: Map<number, SquadEntry>, bank: number): {
    projected: number;
    templateProtection: number;
    rankUtility: number;
    objective: number;
  } => {
    const byPosition = (elementType: number) => Array.from(squad.values())
      .filter(entry => entry.player.element_type === elementType)
      .sort((a, b) => projectedValue(b.player.id) - projectedValue(a.player.id));
    const goalkeepers = byPosition(1);
    const defenders = byPosition(2);
    const midfielders = byPosition(3);
    const forwards = byPosition(4);
    let bestProjected = -Infinity;
    let bestStarterIds = new Set<number>();

    for (let defenderCount = 3; defenderCount <= 5; defenderCount++) {
      for (let midfielderCount = 2; midfielderCount <= 5; midfielderCount++) {
        const forwardCount = 10 - defenderCount - midfielderCount;
        if (forwardCount < 1 || forwardCount > 3) continue;
        const starters = [
          ...goalkeepers.slice(0, 1),
          ...defenders.slice(0, defenderCount),
          ...midfielders.slice(0, midfielderCount),
          ...forwards.slice(0, forwardCount),
        ];
        if (starters.length !== 11) continue;
        const starterScore = starters.reduce((sum, entry) => sum + projectedValue(entry.player.id), 0);
        const attackingCaptainPool = starters.filter(entry => entry.player.element_type === 3 || entry.player.element_type === 4);
        const outfieldCaptainPool = starters.filter(entry => entry.player.element_type !== 1);
        const captainPool = attackingCaptainPool.length > 0 ? attackingCaptainPool : outfieldCaptainPool;
        const captainScore = Math.max(...(captainPool.length > 0 ? captainPool : starters)
          .map(entry => projectedValue(entry.player.id)));
        if (starterScore + captainScore > bestProjected) {
          bestProjected = starterScore + captainScore;
          bestStarterIds = new Set(starters.map(entry => entry.player.id));
        }
      }
    }

    const starters = Array.from(squad.values()).filter(entry => bestStarterIds.has(entry.player.id));
    const bench = Array.from(squad.values()).filter(entry => !bestStarterIds.has(entry.player.id));
    const benchScore = bench.reduce((sum, entry) => sum + projectedValue(entry.player.id) * 0.12, 0);
    const templateProtection = starters.reduce((sum, entry) => sum + templateProtectionBonus(entry.player), 0)
      + bench.reduce((sum, entry) => sum + templateProtectionBonus(entry.player) * 0.12, 0);
    const rankUtility = starters.reduce((sum, entry) => sum + ownershipUtility(entry.player), 0)
      + bench.reduce((sum, entry) => sum + ownershipUtility(entry.player) * 0.12, 0);
    const lowOwnedStarters = starters.filter(entry => ownership(entry.player) < 10).length;
    const concentrationPenalty = Math.max(
      0,
      lowOwnedStarters - activeRankPolicy.risk.maxLowOwnershipStarters
    ) * 1.5;
    const projected = bestProjected + benchScore;
    return {
      projected,
      templateProtection,
      rankUtility,
      objective: projected + templateProtection + rankUtility - concentrationPenalty + bank * 0.015,
    };
  };

  const initialScores = scoreSquad(initialSquad, myTeam.transfers.bank);

  const createTransfer = (outgoing: SquadEntry, incoming: Player, reasoning: string): TransferCandidate => {
    const outProjection = projections.get(outgoing.player.id) ?? engine.calculateExpectedPoints(outgoing.player.id, horizon);
    const inProjection = projections.get(incoming.id) ?? engine.calculateExpectedPoints(incoming.id, horizon);
    projections.set(outgoing.player.id, outProjection);
    projections.set(incoming.id, inProjection);
    const priceChange = engine.predictPriceChange(incoming.id);
    const xpGain = Math.round((inProjection.next5GW - outProjection.next5GW) * 10) / 10;
    return {
      playerOut: outgoing.player,
      playerIn: incoming,
      xpGain,
      hitCost: 0,
      netGain: xpGain,
      confidence: (inProjection.confidence + outProjection.confidence) / 2,
      reasoning,
      priceRisk: priceChange.prediction === 'rise' ? 'rising' : priceChange.prediction === 'fall' ? 'falling' : 'stable',
      sellingPrice: outgoing.sellingPrice,
      purchasePrice: outgoing.purchasePrice,
    };
  };

  if (hasUnlimitedTransfers(myTeam)) {
    const sellingPrices = new Map(myTeam.picks.map(pick => [
      pick.element,
      pick.selling_price ?? engine.getPlayer(pick.element)?.now_cost ?? 0,
    ]));
    const rebuildBudget = myTeam.transfers.bank
      + [...sellingPrices.values()].reduce((sum, price) => sum + price, 0);
    const eligiblePlayers = engine.getAllPlayers()
      .filter(player => originalIds.has(player.id) || (
        player.status === 'a'
        && player.can_select !== false
        && player.can_transact !== false
        && player.removed !== true
      ));
    const enforceMarketFloor = shouldEnforceUnlimitedMarketFloor(activeRankPolicy);
    const marketFloorEligiblePlayers = eligiblePlayers.filter(player =>
      player.status === 'a'
      && player.can_select !== false
      && player.can_transact !== false
      && player.removed !== true
    );
    const marketFloorEligibleIds = new Set(marketFloorEligiblePlayers.map(player => player.id));
    const templateAnchor = enforceMarketFloor ? [...marketFloorEligiblePlayers]
      .filter(player =>
        ownership(player) >= limits.templateAnchorOwnershipThreshold
      )
      .sort((left, right) => ownership(right) - ownership(left) || left.id - right.id)[0] : undefined;
    const candidates: UnlimitedSquadCandidate[] = eligiblePlayers
      .map(player => ({
        player,
        cost: sellingPrices.get(player.id) ?? player.now_cost,
        projectedValue: projectedValue(player.id),
        ownership: ownership(player),
        templateProtectionBonus: templateProtectionBonus(player),
        ownershipUtility: ownershipUtility(player),
        currentlyOwned: originalIds.has(player.id),
        templateCore: enforceMarketFloor
          && marketFloorEligibleIds.has(player.id)
          && ownership(player) >= limits.templateCoreOwnershipThreshold,
        requiredAnchor: player.id === templateAnchor?.id,
      }));
    if (enforceMarketFloor) {
      const availableCorePlayers = candidates.filter(candidate => candidate.templateCore).length;
      if (availableCorePlayers < limits.minimumTemplateCorePlayers) {
        return emptyPlan(
          'unlimited-rebuild',
          `Configured market floor requires ${limits.minimumTemplateCorePlayers} core players at ${limits.templateCoreOwnershipThreshold.toFixed(1)}% ownership; only ${availableCorePlayers} eligible candidates are available`
        );
      }
      if (!templateAnchor) {
        return emptyPlan(
          'unlimited-rebuild',
          `Configured market floor requires an eligible anchor at ${limits.templateAnchorOwnershipThreshold.toFixed(1)}% ownership; none is available`
        );
      }
    }
    const season = engine.getSeasonConfig();
    const target = buildUnlimitedSquad(
      candidates,
      rebuildBudget,
      season.maxPlayersPerClub,
      (squad, bank) => scoreSquad(new Map(squad.map(candidate => [candidate.player.id, {
        player: candidate.player,
        sellingPrice: candidate.cost,
        purchasePrice: candidate.cost,
      }])), bank).objective,
      {
        minimumTemplateCorePlayers: enforceMarketFloor
          ? limits.minimumTemplateCorePlayers
          : 0,
        requireTemplateAnchor: enforceMarketFloor,
      }
    );
    if (!target) return emptyPlan('unlimited-rebuild', 'No legal unlimited-transfer squad could be built');

    const targetSquad = new Map(target.map(candidate => [candidate.player.id, {
      player: candidate.player,
      sellingPrice: candidate.cost,
      purchasePrice: candidate.cost,
    }]));
    const targetCost = target.reduce((sum, candidate) => sum + candidate.cost, 0);
    const targetBank = rebuildBudget - targetCost;
    const targetScores = scoreSquad(targetSquad, targetBank);
    const outgoingByPosition = new Map<number, SquadEntry[]>();
    const incomingByPosition = new Map<number, Player[]>();
    for (const entry of initialSquad.values()) {
      if (!targetSquad.has(entry.player.id)) {
        const values = outgoingByPosition.get(entry.player.element_type) ?? [];
        values.push(entry);
        outgoingByPosition.set(entry.player.element_type, values);
      }
    }
    for (const entry of targetSquad.values()) {
      if (!initialSquad.has(entry.player.id)) {
        const values = incomingByPosition.get(entry.player.element_type) ?? [];
        values.push(entry.player);
        incomingByPosition.set(entry.player.element_type, values);
      }
    }

    const transfers: TransferCandidate[] = [];
    for (const position of SQUAD_POSITION_COUNTS.keys()) {
      const outgoing = (outgoingByPosition.get(position) ?? [])
        .sort((left, right) => projectedValue(left.player.id) - projectedValue(right.player.id) || left.player.id - right.player.id);
      const incoming = (incomingByPosition.get(position) ?? [])
        .sort((left, right) => projectedValue(right.id) - projectedValue(left.id) || left.id - right.id);
      if (outgoing.length !== incoming.length) {
        return emptyPlan('unlimited-rebuild', `Unlimited target has mismatched position ${position} transfers`);
      }
      for (let index = 0; index < outgoing.length; index++) {
        const playerOut = outgoing[index]!;
        const playerIn = incoming[index]!;
        transfers.push(createTransfer(
          playerOut,
          playerIn,
          `${horizon}-GW unlimited rebuild; ownership ${ownership(playerOut.player).toFixed(1)}% -> ${ownership(playerIn).toFixed(1)}%`
        ));
      }
    }

    if (transfers.length === 0) return emptyPlan('unlimited-rebuild');
    if (transfers.length > limits.maxUnlimitedTransfers) {
      return emptyPlan(
        'unlimited-rebuild',
        `Atomic unlimited rebuild requires ${transfers.length} transfers; configured maximum is ${limits.maxUnlimitedTransfers}`
      );
    }
    const expectedGain = targetScores.projected - initialScores.projected;
    const templateProtectionGain = targetScores.templateProtection - initialScores.templateProtection;
    const rankUtilityGain = targetScores.rankUtility - initialScores.rankUtility;
    const objectiveGain = targetScores.objective - initialScores.objective;
    if (!isUnlimitedRebuildImprovement(expectedGain, objectiveGain)) {
      return emptyPlan(
        'unlimited-rebuild',
        `Unlimited rebuild did not improve projected points safely (xP ${expectedGain.toFixed(1)}, objective ${objectiveGain.toFixed(1)}; target ${target.map(candidate => candidate.player.web_name).join(', ')})`
      );
    }
    const confidence = getAtomicTransferConfidence(transfers);
    const reportedExpectedGain = Math.abs(expectedGain) < 0.1 ? 0 : Math.round(expectedGain * 10) / 10;
    return {
      transfers,
      expectedGain: reportedExpectedGain,
      hitCost: 0,
      netGain: reportedExpectedGain,
      templateProtectionGain: Math.round(templateProtectionGain * 100) / 100,
      rankUtilityGain: Math.round(rankUtilityGain * 100) / 100,
      objectiveGain: Math.round(objectiveGain * 10) / 10,
      confidence,
      horizon,
      mode: 'unlimited-rebuild',
      targetPlayerIds: [...targetSquad.keys()].sort((left, right) => left - right),
    };
  }

  const replacementPool = new Map<number, Player[]>();
  for (let position = 1; position <= 4; position++) {
    replacementPool.set(position, engine.getAllPlayers()
      .filter(player =>
        player.element_type === position
        && player.status === 'a'
        && player.can_select !== false
        && player.can_transact !== false
        && player.removed !== true
      )
      .sort((a, b) =>
        projectedValue(b.id) + templateProtectionBonus(b) + ownershipUtility(b)
        - projectedValue(a.id) - templateProtectionBonus(a) - ownershipUtility(a)
      )
      .slice(0, 14));
  }

  let beam: SearchState[] = [{
    squad: initialSquad,
    bank: myTeam.transfers.bank,
    transfers: [],
    usedOut: new Set(),
    score: initialScores.objective,
  }];
  let bestState = beam[0]!;
  const depthLimit = Math.max(0, Math.min(maximumTransfers, 5));

  for (let depth = 1; depth <= depthLimit; depth++) {
    const expanded: SearchState[] = [];
    for (const state of beam) {
      for (const outgoing of state.squad.values()) {
        if (!originalIds.has(outgoing.player.id) || state.usedOut.has(outgoing.player.id)) continue;
        for (const incoming of replacementPool.get(outgoing.player.element_type) ?? []) {
          if (state.squad.has(incoming.id)) continue;
          const newBank = state.bank + outgoing.sellingPrice - incoming.now_cost;
          if (newBank < 0) continue;

          const clubCount = Array.from(state.squad.values())
            .filter(entry => entry.player.team === incoming.team && entry.player.id !== outgoing.player.id).length;
          if (clubCount >= 3) continue;

          const squad = new Map(state.squad);
          squad.delete(outgoing.player.id);
          squad.set(incoming.id, {
            player: incoming,
            sellingPrice: incoming.now_cost,
            purchasePrice: incoming.now_cost,
          });
          const usedOut = new Set(state.usedOut).add(outgoing.player.id);
          const transfer = createTransfer(outgoing, incoming, `${horizon}-GW incremental squad optimization`);
          const transfers = [...state.transfers, transfer];
          const hitCost = Math.max(0, transfers.length - freeTransfers) * 4;
          expanded.push({
            squad,
            bank: newBank,
            transfers,
            usedOut,
            score: scoreSquad(squad, newBank).objective - hitCost,
          });
        }
      }
    }

    const unique = new Map<string, SearchState>();
    for (const state of expanded) {
      const key = Array.from(state.squad.keys()).sort((a, b) => a - b).join(',');
      const existing = unique.get(key);
      if (!existing || state.score > existing.score) unique.set(key, state);
    }
    beam = Array.from(unique.values()).sort((a, b) => b.score - a.score).slice(0, 40);
    if (beam.length === 0) break;
    if (beam[0]!.score > bestState.score) bestState = beam[0]!;
  }

  const hitCost = Math.max(0, bestState.transfers.length - freeTransfers) * 4;
  const finalScores = scoreSquad(bestState.squad, bestState.bank);
  const expectedGain = finalScores.projected - initialScores.projected;
  const templateProtectionGain = finalScores.templateProtection - initialScores.templateProtection;
  const rankUtilityGain = finalScores.rankUtility - initialScores.rankUtility;
  const netGain = expectedGain - hitCost;
  const objectiveGain = finalScores.objective - initialScores.objective - hitCost;
  const maxSavedFreeTransfers = engine.getSeasonConfig().maxSavedFreeTransfers;
  const canStillBank = freeTransfers < maxSavedFreeTransfers;
  const urgentExit = bestState.transfers.some(transfer =>
    transfer.playerOut.status === 'i'
    || transfer.playerOut.status === 's'
    || (projections.get(transfer.playerOut.id)?.nextGW ?? 0) <= 0.5
  );
  const modePremium = activeRankPolicy.mode === 'protect'
    ? 0.5
    : activeRankPolicy.mode === 'balanced'
      ? 0.25
      : 0;
  const minimumNetGain = urgentExit ? 0.5 : (canStillBank ? 1.25 : 0.5) + modePremium;
  if (netGain < minimumNetGain || objectiveGain <= 0) return emptyPlan('incremental');
  const confidence = bestState.transfers.length > 0
    ? bestState.transfers.reduce((sum, transfer) => sum + transfer.confidence, 0) / bestState.transfers.length
    : 1;

  return {
    transfers: bestState.transfers,
    expectedGain: bestState.transfers.length > 0 ? Math.round(expectedGain * 10) / 10 : 0,
    hitCost: bestState.transfers.length > 0 ? hitCost : 0,
    netGain: bestState.transfers.length > 0 ? Math.round(netGain * 10) / 10 : 0,
    templateProtectionGain: bestState.transfers.length > 0 ? Math.round(templateProtectionGain * 100) / 100 : 0,
    rankUtilityGain: bestState.transfers.length > 0 ? Math.round(rankUtilityGain * 100) / 100 : 0,
    objectiveGain: bestState.transfers.length > 0 ? Math.round(objectiveGain * 10) / 10 : 0,
    confidence,
    horizon,
    mode: 'incremental',
    targetPlayerIds: [...bestState.squad.keys()].sort((left, right) => left - right),
  };
}

/**
 * Select optimal captain based on xP and EO analysis
 */
export async function selectOptimalCaptain(
  myTeam: MyTeam
): Promise<{ captain: Player; xp: number; alternatives: Player[] }> {
  const engine = await getOptimizationEngine();
  const lineup = await selectOptimalLineup(myTeam);
  const alternatives = lineup.startingXI
    .filter(player => player.id !== lineup.captain.id && player.element_type !== 1)
    .sort((left, right) =>
      engine.calculateExpectedPoints(right.id, 1).nextGW - engine.calculateExpectedPoints(left.id, 1).nextGW
      || left.id - right.id
    )
    .slice(0, 3);
  return {
    captain: lineup.captain,
    xp: lineup.captainExpectedPoints,
    alternatives,
  };
}

export async function selectOptimalLineup(
  myTeam: MyTeam,
  rankPolicy?: RankPolicy
): Promise<OptimalLineup> {
  const engine = await getOptimizationEngine();
  const players = myTeam.picks.map(pick => engine.getPlayer(pick.element)).filter((player): player is Player => Boolean(player));
  if (players.length !== 15) throw new Error('Cannot optimize an incomplete squad');

  const ranked = (elementType: number) => players
    .filter(player => player.element_type === elementType)
    .map(player => {
      const projection = engine.calculateExpectedPoints(player.id, 1);
      return {
        player,
        xp: projection.nextGW,
        p90: projection.distribution.p90,
        startProbability: projection.availability.startProbability,
      };
    })
    .sort((a, b) => b.xp - a.xp || a.player.id - b.player.id);
  const goalkeepers = ranked(1);
  const defenders = ranked(2);
  const midfielders = ranked(3);
  const forwards = ranked(4);

  let best: { starters: typeof defenders; score: number } | null = null;
  for (let defenderCount = 3; defenderCount <= 5; defenderCount++) {
    for (let midfielderCount = 2; midfielderCount <= 5; midfielderCount++) {
      const forwardCount = 10 - defenderCount - midfielderCount;
      if (forwardCount < 1 || forwardCount > 3) continue;
      const starters = [
        ...goalkeepers.slice(0, 1),
        ...defenders.slice(0, defenderCount),
        ...midfielders.slice(0, midfielderCount),
        ...forwards.slice(0, forwardCount),
      ];
      const score = starters.reduce((total, entry) => total + entry.xp, 0);
      if (starters.length === 11 && (!best || score > best.score)) best = { starters, score };
    }
  }

  if (!best) throw new Error('No legal starting XI can be selected');
  const starterIds = new Set(best.starters.map(entry => entry.player.id));
  const benchGoalkeeper = goalkeepers.find(entry => !starterIds.has(entry.player.id));
  const benchOutfield = [...defenders, ...midfielders, ...forwards]
    .filter(entry => !starterIds.has(entry.player.id))
    .sort((a, b) => b.xp - a.xp || a.player.id - b.player.id);
  if (!benchGoalkeeper || benchOutfield.length !== 3) throw new Error('Cannot construct a legal bench');

  const captaincy = selectStableCaptaincy(best.starters, myTeam, rankPolicy);
  const captain = captaincy.captain.player;
  const viceCaptain = captaincy.viceCaptain.player;
  const ordered = [...best.starters.map(entry => entry.player), benchGoalkeeper.player, ...benchOutfield.map(entry => entry.player)];
  const selection = ordered.map((player, index) => ({
    element: player.id,
    position: index + 1,
    isCaptain: player.id === captain.id,
    isViceCaptain: player.id === viceCaptain.id,
  }));

  return {
    selection,
    startingXI: best.starters.map(entry => entry.player),
    bench: [benchGoalkeeper.player, ...benchOutfield.map(entry => entry.player)],
    captain,
    viceCaptain,
    captainExpectedPoints: captaincy.captain.xp,
    expectedPoints: best.score + captaincy.captain.xp,
    confidence: Math.min(...best.starters.map(entry => entry.xp > 0
      ? engine.calculateExpectedPoints(entry.player.id, 1).confidence
      : 0)),
  };
}

export function selectStableCaptaincy(
  starters: { player: Player; xp: number; p90?: number; startProbability?: number }[],
  myTeam: Pick<MyTeam, 'picks'>,
  rankPolicy?: RankPolicy
): {
  captain: { player: Player; xp: number; p90?: number; startProbability?: number };
  viceCaptain: { player: Player; xp: number; p90?: number; startProbability?: number };
} {
  const policy = rankPolicy ?? deriveRankPolicy({
    gameweek: 1,
    overallRank: null,
    targetRank: null,
  });
  const outfield = starters.filter(entry => entry.player.element_type !== 1);
  const rawPool = outfield.length >= 2 ? outfield : starters;
  const meanReference = [...rawPool].sort((left, right) => right.xp - left.xp || left.player.id - right.player.id)[0]!;
  const qualified = rawPool.filter(entry =>
    entry.xp >= meanReference.xp * policy.risk.minimumQualityRatio
    && (entry.startProbability ?? 1) >= policy.risk.captainMinimumStartProbability
  );
  const pool = qualified.length >= 2 ? qualified : rawPool;
  const ranked = [...pool].sort((left, right) =>
    captainScore(right, meanReference, policy) - captainScore(left, meanReference, policy)
    || right.xp - left.xp
    || left.player.id - right.player.id
  );
  const currentCaptainId = myTeam.picks.find(pick => pick.is_captain)?.element;
  const currentViceId = myTeam.picks.find(pick => pick.is_vice_captain)?.element;
  const best = ranked[0]!;
  const currentCaptain = ranked.find(entry => entry.player.id === currentCaptainId);
  const stabilityTolerance = policy.mode === 'protect' ? 0.6 : policy.mode === 'push' ? 0.15 : 0.35;
  const captain = currentCaptain && currentCaptain.xp >= best.xp - stabilityTolerance
    ? currentCaptain
    : best;
  const vicePool = ranked.filter(entry => entry.player.id !== captain.player.id);
  const bestVice = vicePool[0]!;
  const currentVice = vicePool.find(entry => entry.player.id === currentViceId);
  const viceCaptain = currentVice && currentVice.xp >= bestVice.xp - stabilityTolerance
    ? currentVice
    : bestVice;
  return { captain, viceCaptain };
}

export async function calculateCurrentLineupExpectedPoints(myTeam: MyTeam): Promise<number> {
  const engine = await getOptimizationEngine();
  let total = 0;
  for (const pick of myTeam.picks.filter(candidate => candidate.position <= 11)) {
    const points = engine.calculateExpectedPoints(pick.element, 1).nextGW;
    total += points;
    if (pick.is_captain) total += points;
  }
  return Math.round(total * 10) / 10;
}

function captainScore(
  entry: { player: Player; xp: number; p90?: number },
  reference: { player: Player; xp: number; p90?: number },
  policy: RankPolicy
): number {
  const ownership = parseOfficialOwnership(entry.player.selected_by_percent);
  const referenceOwnership = parseOfficialOwnership(reference.player.selected_by_percent);
  const upsideEdge = Math.max(0, (entry.p90 ?? entry.xp) - (reference.p90 ?? reference.xp));
  const leverage = Math.max(0, (referenceOwnership - ownership) / 100);
  const hedge = Math.max(0, (ownership - referenceOwnership) / 100);
  return entry.xp
    + upsideEdge * leverage * policy.risk.upsideWeight * 0.25
    + hedge * policy.risk.highOwnershipHedgeWeight * 0.25;
}

/**
 * Evaluate if any chip should be played
 */
export async function evaluateChips(
  myTeam: MyTeam,
  gameweek: number,
  proposedLineup?: { startingXI: Player[]; bench: Player[] }
): Promise<{ chip: string; recommended: boolean; expectedGain: number; confidence: number; reasoning: string }[]> {
  const engine = await getOptimizationEngine();
  
  const chips: ('wildcard' | 'freehit' | 'bboost' | '3xc')[] = ['wildcard', 'freehit', 'bboost', '3xc'];
  // A chip is playable only when this entry still holds it AND the gameweek falls
  // inside that chip instance's window (chips are split into first/second-half copies).
  const availableChips = myTeam.chips
    .filter(c => c.status_for_entry === 'available')
    .filter(c => gameweek >= c.start_event && gameweek <= c.stop_event)
    .map(c => c.name);

  const recommendations: { chip: string; recommended: boolean; expectedGain: number; confidence: number; reasoning: string }[] = [];
  
  const squadPlayerIds = proposedLineup
    ? proposedLineup.startingXI.map(player => player.id)
    : myTeam.picks.filter(p => p.position <= 11).map(p => p.element);
  const benchPlayerIds = proposedLineup
    ? proposedLineup.bench.map(player => player.id)
    : myTeam.picks.filter(p => p.position > 11).map(p => p.element);
  
  for (const chip of chips) {
    if (!availableChips.includes(chip)) continue;
    
    const evaluation = engine.evaluateChip(chip, gameweek, squadPlayerIds, benchPlayerIds);
    recommendations.push({
      chip,
      recommended: evaluation.recommended,
      expectedGain: evaluation.expectedGain,
      confidence: evaluation.confidence,
      reasoning: evaluation.reasoning,
    });
  }
  
  return recommendations.filter(r => r.recommended).sort((a, b) => b.expectedGain - a.expectedGain);
}

/**
 * Build full decision context
 */
export async function buildDecisionContext(): Promise<DecisionContext | null> {
  const client = getFPLClient();
  const engine = await getOptimizationEngine();
  
  if (!client.isAuthenticated()) {
    console.log('[DECISION] Not authenticated, cannot build context');
    return null;
  }
  
  const deadlineInfo = engine.getNextDeadline();
  const gameweek = deadlineInfo?.gameweek ?? engine.getCurrentGameweek();
  resetWeeklyTransfers(gameweek);
  
  // Get team data with retry and fallback
  let myTeam: MyTeam | null = null;
  
  // Try authenticated endpoint with retries (FPL API can return 403 temporarily)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      myTeam = await client.getMyTeam();
      break; // Success, exit retry loop
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const isRetryable = errMsg.includes('403') || errMsg.includes('429') || errMsg.includes('5');
      
      if (isRetryable && attempt < 3) {
        console.log(`[DECISION] Attempt ${attempt} failed: ${errMsg}. Retrying in ${attempt * 2}s...`);
        await new Promise(resolve => setTimeout(resolve, attempt * 2000));
      } else if (attempt === 3 || !isRetryable) {
        console.error(`[DECISION] Failed to get team after ${attempt} attempts:`, error);
        break;
      }
    }
  }
  
  if (!myTeam) {
    console.log('[DECISION] Failed to get authenticated team data; skipping executable cycle');
    return null;
  }
  const managerId = client.getManagerId();
  if (!managerId) {
    console.log('[DECISION] Authenticated manager identity is unavailable; skipping executable cycle');
    return null;
  }
  
  // Use real deadline from optimizer
  const now = new Date();
  let hoursToDeadline = 0;
  let isPreDeadline = false;
  
  if (deadlineInfo) {
    hoursToDeadline = deadlineInfo.hoursRemaining;
    isPreDeadline = hoursToDeadline <= getRunnerTimingConfig().preDeadlineHours;
  } else {
    // Fallback to simplified calculation if no deadline found
    const hourOfDay = now.getUTCHours();
    hoursToDeadline = Math.max(0, (6 - now.getUTCDay()) * 24 + (11 - hourOfDay));
    isPreDeadline = hoursToDeadline <= getRunnerTimingConfig().preDeadlineHours;
  }
  
  // Analyze team health
  const teamHealth = await analyzeTeamHealth(myTeam);
  
  // Gather intelligence on player changes
  const intelligence = await gatherIntelligence(gameweek, deadlineInfo?.deadline);
  let rankPolicy = deriveRankPolicy({
    gameweek,
    overallRank: null,
    targetRank: getConfiguredTargetRank(),
    previousMode: previousRankModeByManager.get(managerId),
  });
  try {
    const entry = await client.getEntry(managerId);
    const overallLeague = entry.leagues.classic.find(league =>
      league.name.trim().toLowerCase() === 'overall'
    );
    rankPolicy = deriveRankPolicy({
      gameweek,
      overallRank: entry.summary_overall_rank,
      targetRank: getConfiguredTargetRank(),
      previousOverallRank: overallLeague?.entry_last_rank ?? null,
      previousMode: previousRankModeByManager.get(managerId),
    });
  } catch (error) {
    console.warn('[DECISION] Rank state unavailable; using balanced policy:', error);
  }
  previousRankModeByManager.set(managerId, rankPolicy.mode);
  
  return {
    season: engine.getSeasonConfig().season,
    managerId,
    gameweek,
    deadline: deadlineInfo?.deadline ?? null,
    hoursToDeadline,
    isPreDeadline,
    myTeam,
    freeTransfers: getFreeTransfers(myTeam),
    bank: myTeam.transfers.bank,
    teamHealth,
    playerStatusChanges: intelligence.statusChanges,
    newsAlerts: intelligence.newsAlerts,
    externalNews: intelligence.externalNews,
    newsSignals: intelligence.newsSignals,
    intelligenceFeed: intelligence.intelligenceFeed,
    rankPolicy,
  };
}
