// Decision Engine for Autonomous Mode
// Includes intelligence gathering for late news and player updates
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';
import { logDecision, getDecisionsByType, savePlayerNewsSignals } from '../db/client.js';
import { validateTransfer, validateChip, resetWeeklyTransfers } from './limits.js';
import { gatherFPLNews, type NewsItem } from './news.js';
import type { Player, MyTeam } from '../api/types.js';
import type { TeamSelection } from '../api/client.js';
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
}

export interface OptimizedTransferPlan {
  transfers: TransferCandidate[];
  expectedGain: number;
  hitCost: number;
  netGain: number;
  confidence: number;
  horizon: number;
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
}

export interface DecisionContext {
  gameweek: number;
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
}

// Cache for detecting player status changes (late news)
const playerStatusCache = new Map<number, string>();

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
  const externalNews = await gatherFPLNews();
  const targetGameweek = gameweek ?? engine.getNextDeadline()?.gameweek ?? engine.getCurrentGameweek();
  const targetDeadline = deadline ?? engine.getNextDeadline()?.deadline ?? new Date(Date.now() + 7 * 86_400_000);
  const newsSignals = mergePlayerNewsSignals([
    ...buildOfficialNewsSignals(allPlayers, targetGameweek, targetDeadline),
    ...buildExternalNewsSignals({ items: externalNews, players: allPlayers, gameweek: targetGameweek, deadline: targetDeadline }),
  ]);
  engine.setNewsSignals(newsSignals);
  await savePlayerNewsSignals(newsSignals);
  
  // Add high priority news to alerts
  for (const news of externalNews.filter(n => n.priority === 'high')) {
    newsAlerts.push(`BREAKING: ${news.title.substring(0, 100)}`);
  }
  
  return { statusChanges, priceChanges, newsAlerts, externalNews, newsSignals };
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
  const freeTransfers = myTeam.transfers.limit - myTeam.transfers.made;
  const bank = myTeam.transfers.bank;
  const sellingPrices = new Map(myTeam.picks.map(p => [p.element, p.selling_price]));
  
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
        });
      }
    }
  }
  
  // Sort by net gain and return top candidates
  return candidates
    .sort((a, b) => b.netGain - a.netGain)
    .slice(0, maxCandidates);
}

export async function optimizeTransferPlan(
  myTeam: MyTeam,
  maximumTransfers: number,
  horizon: number = 6
): Promise<OptimizedTransferPlan> {
  const engine = await getOptimizationEngine();
  const freeTransfers = Math.max(0, myTeam.transfers.limit - myTeam.transfers.made);
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

  type SquadEntry = { player: Player; sellingPrice: number };
  type SearchState = {
    squad: Map<number, SquadEntry>;
    bank: number;
    transfers: TransferCandidate[];
    usedOut: Set<number>;
    score: number;
  };

  const initialSquad = new Map<number, SquadEntry>();
  for (const pick of myTeam.picks) {
    const player = engine.getPlayer(pick.element);
    if (player) initialSquad.set(player.id, { player, sellingPrice: pick.selling_price ?? player.now_cost });
  }
  if (initialSquad.size !== 15) throw new Error('Cannot optimize an incomplete squad');

  const scoreSquad = (squad: Map<number, SquadEntry>, bank: number): number => {
    const byPosition = (elementType: number) => Array.from(squad.values())
      .filter(entry => entry.player.element_type === elementType)
      .sort((a, b) => projectedValue(b.player.id) - projectedValue(a.player.id));
    const goalkeepers = byPosition(1);
    const defenders = byPosition(2);
    const midfielders = byPosition(3);
    const forwards = byPosition(4);
    let bestScore = -Infinity;
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
        const captainScore = Math.max(...starters.map(entry => projectedValue(entry.player.id)));
        if (starterScore + captainScore > bestScore) {
          bestScore = starterScore + captainScore;
          bestStarterIds = new Set(starters.map(entry => entry.player.id));
        }
      }
    }

    const benchScore = Array.from(squad.values())
      .filter(entry => !bestStarterIds.has(entry.player.id))
      .reduce((sum, entry) => sum + projectedValue(entry.player.id) * 0.12, 0);
    return bestScore + benchScore + bank * 0.015;
  };

  const replacementPool = new Map<number, Player[]>();
  for (let position = 1; position <= 4; position++) {
    replacementPool.set(position, engine.getAllPlayers()
      .filter(player => player.element_type === position && player.status === 'a')
      .sort((a, b) => projectedValue(b.id) - projectedValue(a.id))
      .slice(0, 14));
  }

  const initialScore = scoreSquad(initialSquad, myTeam.transfers.bank);
  let beam: SearchState[] = [{
    squad: initialSquad,
    bank: myTeam.transfers.bank,
    transfers: [],
    usedOut: new Set(),
    score: initialScore,
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
          squad.set(incoming.id, { player: incoming, sellingPrice: incoming.now_cost });
          const usedOut = new Set(state.usedOut).add(outgoing.player.id);
          const outProjection = projections.get(outgoing.player.id) ?? engine.calculateExpectedPoints(outgoing.player.id, horizon);
          const inProjection = projections.get(incoming.id) ?? engine.calculateExpectedPoints(incoming.id, horizon);
          projections.set(outgoing.player.id, outProjection);
          projections.set(incoming.id, inProjection);
          const priceChange = engine.predictPriceChange(incoming.id);
          const transfer: TransferCandidate = {
            playerOut: outgoing.player,
            playerIn: incoming,
            xpGain: Math.round((inProjection.next5GW - outProjection.next5GW) * 10) / 10,
            hitCost: 0,
            netGain: 0,
            confidence: (inProjection.confidence + outProjection.confidence) / 2,
            reasoning: `${horizon}-GW squad optimization`,
            priceRisk: priceChange.prediction === 'rise' ? 'rising' : priceChange.prediction === 'fall' ? 'falling' : 'stable',
            sellingPrice: outgoing.sellingPrice,
          };
          const transfers = [...state.transfers, transfer];
          const hitCost = Math.max(0, transfers.length - freeTransfers) * 4;
          expanded.push({
            squad,
            bank: newBank,
            transfers,
            usedOut,
            score: scoreSquad(squad, newBank) - hitCost,
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
  const expectedGain = bestState.score - initialScore + hitCost;
  const netGain = expectedGain - hitCost;
  if (netGain < 0.5) bestState = { ...bestState, transfers: [] };
  const confidence = bestState.transfers.length > 0
    ? bestState.transfers.reduce((sum, transfer) => sum + transfer.confidence, 0) / bestState.transfers.length
    : 1;

  return {
    transfers: bestState.transfers,
    expectedGain: bestState.transfers.length > 0 ? Math.round(expectedGain * 10) / 10 : 0,
    hitCost: bestState.transfers.length > 0 ? hitCost : 0,
    netGain: bestState.transfers.length > 0 ? Math.round(netGain * 10) / 10 : 0,
    confidence,
    horizon,
  };
}

/**
 * Select optimal captain based on xP and EO analysis
 */
export async function selectOptimalCaptain(
  myTeam: MyTeam
): Promise<{ captain: Player; xp: number; alternatives: Player[] }> {
  const engine = await getOptimizationEngine();
  
  // Only consider starting XI for captain
  const startingXI = myTeam.picks
    .filter(p => p.position <= 11)
    .map(p => p.element);
  
  const captainOptions = engine.getAlternativeCaptains(startingXI, 5);
  
  const bestOption = captainOptions[0];
  const captain = engine.getPlayer(
    startingXI.find(id => engine.getPlayer(id)?.web_name === bestOption.player) || startingXI[0]
  )!;
  
  const alternatives = captainOptions.slice(1, 4).map(opt => 
    engine.getPlayer(
      startingXI.find(id => engine.getPlayer(id)?.web_name === opt.player)!
    )!
  ).filter(Boolean);
  
  return {
    captain,
    xp: bestOption.xpNextGW,
    alternatives,
  };
}

export async function selectOptimalLineup(myTeam: MyTeam): Promise<OptimalLineup> {
  const engine = await getOptimizationEngine();
  const players = myTeam.picks.map(pick => engine.getPlayer(pick.element)).filter((player): player is Player => Boolean(player));
  if (players.length !== 15) throw new Error('Cannot optimize an incomplete squad');

  const ranked = (elementType: number) => players
    .filter(player => player.element_type === elementType)
    .map(player => ({ player, xp: engine.calculateExpectedPoints(player.id, 1).nextGW }))
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

  const captaincy = [...best.starters].sort((a, b) => b.xp - a.xp || a.player.id - b.player.id);
  const captain = captaincy[0]!.player;
  const viceCaptain = captaincy[1]!.player;
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
    captainExpectedPoints: captaincy[0]!.xp,
    expectedPoints: best.score,
  };
}

/**
 * Evaluate if any chip should be played
 */
export async function evaluateChips(
  myTeam: MyTeam,
  gameweek: number
): Promise<{ chip: string; recommended: boolean; expectedGain: number; confidence: number; reasoning: string }[]> {
  const engine = await getOptimizationEngine();
  
  const chips: ('wildcard' | 'freehit' | 'bboost' | '3xc')[] = ['wildcard', 'freehit', 'bboost', '3xc'];
  const availableChips = myTeam.chips
    .filter(c => c.status_for_entry === 'available')
    .map(c => c.name);
  
  const recommendations: { chip: string; recommended: boolean; expectedGain: number; confidence: number; reasoning: string }[] = [];
  
  const squadPlayerIds = myTeam.picks.filter(p => p.position <= 11).map(p => p.element);
  const benchPlayerIds = myTeam.picks.filter(p => p.position > 11).map(p => p.element);
  
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
  
  // Use real deadline from optimizer
  const now = new Date();
  let hoursToDeadline = 0;
  let isPreDeadline = false;
  
  if (deadlineInfo) {
    hoursToDeadline = deadlineInfo.hoursRemaining;
    isPreDeadline = hoursToDeadline <= parseInt(process.env.PRE_DEADLINE_HOURS || '2');
  } else {
    // Fallback to simplified calculation if no deadline found
    const hourOfDay = now.getUTCHours();
    hoursToDeadline = Math.max(0, (6 - now.getUTCDay()) * 24 + (11 - hourOfDay));
    isPreDeadline = hoursToDeadline <= parseInt(process.env.PRE_DEADLINE_HOURS || '2');
  }
  
  // Analyze team health
  const teamHealth = await analyzeTeamHealth(myTeam);
  
  // Gather intelligence on player changes
  const intelligence = await gatherIntelligence(gameweek, deadlineInfo?.deadline);
  
  return {
    gameweek,
    hoursToDeadline,
    isPreDeadline,
    myTeam,
    freeTransfers: myTeam.transfers.limit - myTeam.transfers.made,
    bank: myTeam.transfers.bank,
    teamHealth,
    playerStatusChanges: intelligence.statusChanges,
    newsAlerts: intelligence.newsAlerts,
    externalNews: intelligence.externalNews,
    newsSignals: intelligence.newsSignals,
  };
}
