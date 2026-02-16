// Decision Engine for Autonomous Mode
// Includes intelligence gathering for late news and player updates
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';
import { logDecision, getDecisionsByType } from '../db/client.js';
import { validateTransfer, validateChip, resetWeeklyTransfers } from './limits.js';
import { gatherFPLNews, type NewsItem } from './news.js';
import type { Player, MyTeam } from '../api/types.js';

export interface TransferCandidate {
  playerOut: Player;
  playerIn: Player;
  xpGain: number;
  hitCost: number;
  netGain: number;
  confidence: number;
  reasoning: string;
  priceRisk: 'rising' | 'falling' | 'stable';
}

export interface TeamHealth {
  injuries: { player: Player; status: string; chance: number }[];
  suspensions: Player[];
  blankingPlayers: Player[];
  doubts: Player[];
  alerts: string[];
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
  externalNews: NewsItem[];
}

// Cache for detecting player status changes (late news)
const playerStatusCache = new Map<number, string>();

/**
 * Gather intelligence on player status changes since last check
 * This catches late news like injuries, doubts, suspensions
 */
export async function gatherIntelligence(): Promise<{
  statusChanges: { player: Player; oldStatus: string; newStatus: string }[];
  priceChanges: { player: Player; direction: 'up' | 'down'; amount: number }[];
  newsAlerts: string[];
  externalNews: NewsItem[];
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
  
  // Add high priority news to alerts
  for (const news of externalNews.filter(n => n.priority === 'high')) {
    newsAlerts.push(`BREAKING: ${news.title.substring(0, 100)}`);
  }
  
  return { statusChanges, priceChanges, newsAlerts, externalNews };
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
  
  const candidates: TransferCandidate[] = [];
  const squadPlayerIds = myTeam.picks.map(p => p.element);
  
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
    const maxPrice = playerOut.now_cost + bank;
    const position = playerOut.element_type;
    
    // Get all available players in same position
    const allPlayers = engine.getAllPlayers();
    const replacements = allPlayers
      .filter(p => 
        p.element_type === position &&
        p.now_cost <= maxPrice &&
        p.status === 'a' &&
        !squadPlayerIds.includes(p.id) &&
        p.id !== playerOut.id
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
        });
      }
    }
  }
  
  // Sort by net gain and return top candidates
  return candidates
    .sort((a, b) => b.netGain - a.netGain)
    .slice(0, maxCandidates);
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
  
  const gameweek = engine.getCurrentGameweek();
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
    console.log('[DECISION] Using fallback team data from bootstrap');
    // Fall back to public endpoint data - create minimal MyTeam from bootstrap
    const allPlayers = engine.getAllPlayers();
    const picks = allPlayers.slice(0, 15).map((p, i) => ({
      element: p.id,
      position: i + 1,
      multiplier: i === 0 ? 2 : 1, // First player is captain
      is_captain: i === 0,
      is_vice_captain: i === 1,
    }));
    
    myTeam = {
      picks,
      chips: [],
      transfers: {
        cost: 0,
        status: 'ok',
        limit: 1,
        made: 0,
        bank: 10, // Default 1.0m in bank
        value: 1000, // Default 100.0m team value
      },
    };
  }
  
  // Use real deadline from optimizer
  const deadlineInfo = engine.getNextDeadline();
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
  const intelligence = await gatherIntelligence();
  
  return {
    gameweek,
    hoursToDeadline,
    isPreDeadline,
    myTeam,
    freeTransfers: myTeam.transfers.limit - myTeam.transfers.made,
    bank: myTeam.transfers.bank,
    teamHealth,
    playerStatusChanges: intelligence.statusChanges,
    externalNews: intelligence.externalNews,
  };
}
