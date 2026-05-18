// Game Theory Optimization Engine
import { getFPLClient } from '../api/client.js';
import type { Player, Fixture, Team, Gameweek } from '../api/types.js';

export interface ExpectedPoints {
  playerId: number;
  playerName: string;
  team: string;
  position: string;
  nextGW: number;
  next5GW: number;
  confidence: number; // 0-1
  breakdown: {
    formFactor: number;
    fixtureFactor: number;
    minutesFactor: number;
    setpieceFactor: number;
  };
}

export interface TransferRecommendation {
  playerOut: Player;
  playerIn: Player;
  xpGain: number; // Expected points gain over horizon
  hitCost: number; // 0 or 4
  netGain: number; // xpGain - hitCost
  horizon: number; // GWs considered
  confidence: number;
  reasoning: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ChipRecommendation {
  chip: 'wildcard' | 'freehit' | 'bboost' | '3xc';
  recommended: boolean;
  gameweek: number;
  expectedGain: number;
  reasoning: string;
  confidence: number;
}

// Fixture Difficulty Rating weights
const FDR_WEIGHTS: Record<number, number> = {
  1: 1.3,  // Very easy
  2: 1.15, // Easy
  3: 1.0,  // Medium
  4: 0.85, // Hard
  5: 0.7,  // Very hard
};

// Position multipliers for calculating xP
const POSITION_BASE_XP: Record<number, number> = {
  1: 4.0,  // GK
  2: 4.2,  // DEF
  3: 5.0,  // MID
  4: 4.5,  // FWD
};

class OptimizationEngine {
  private players: Map<number, Player> = new Map();
  private teams: Map<number, Team> = new Map();
  private fixtures: Fixture[] = [];
  private gameweeks: Gameweek[] = [];
  private currentGW: number = 1;

  async initialize(): Promise<void> {
    const client = getFPLClient();
    const bootstrap = await client.getBootstrapStatic();
    
    // Index players and teams
    bootstrap.elements.forEach(p => this.players.set(p.id, p));
    bootstrap.teams.forEach(t => this.teams.set(t.id, t));
    
    // Store gameweeks for deadline access
    this.gameweeks = bootstrap.events;
    
    // Get current gameweek
    const currentEvent = bootstrap.events.find(e => e.is_current);
    this.currentGW = currentEvent?.id || 1;
    
    // Get all fixtures
    this.fixtures = await client.getFixtures();
  }

  // Calculate Expected Points for a player
  calculateExpectedPoints(playerId: number, gameweeks: number = 5): ExpectedPoints {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error(`Player ${playerId} not found`);
    }

    const team = this.teams.get(player.team);
    const positionName = this.getPositionName(player.element_type);
    
    // Get upcoming fixtures for this player's team
    const upcomingFixtures = this.getUpcomingFixtures(player.team, gameweeks);
    
    // Form factor (0.5 to 1.5 based on form)
    const form = parseFloat(player.form) || 0;
    const formFactor = Math.max(0.5, Math.min(1.5, 0.8 + (form / 10)));
    
    // Minutes factor (0 to 1 based on recent starts)
    const minutesFactor = Math.min(1, player.minutes / (this.currentGW * 90 * 0.9));
    
    // Set piece factor (bonus for set piece takers)
    let setpieceFactor = 1.0;
    if (player.penalties_order === 1) setpieceFactor += 0.15;
    if (player.corners_and_indirect_freekicks_order === 1) setpieceFactor += 0.1;
    if (player.direct_freekicks_order === 1) setpieceFactor += 0.05;
    
    // Calculate fixture factor (average FDR weight for upcoming fixtures)
    let fixtureFactor = 1.0;
    if (upcomingFixtures.length > 0) {
      const fdrSum = upcomingFixtures.reduce((sum, f) => {
        const isHome = f.team_h === player.team;
        const fdr = isHome ? f.team_a_difficulty : f.team_h_difficulty;
        return sum + (FDR_WEIGHTS[fdr] || 1.0);
      }, 0);
      fixtureFactor = fdrSum / upcomingFixtures.length;
    }
    
    // Base expected points from position and PPG
    const baseXP = POSITION_BASE_XP[player.element_type] || 4.0;
    const ppg = parseFloat(player.points_per_game) || baseXP;
    
    // Calculate next GW xP
    const nextGWXP = ppg * formFactor * minutesFactor * setpieceFactor * 
      (upcomingFixtures.length > 0 ? (FDR_WEIGHTS[this.getNextFDR(upcomingFixtures[0], player.team)] || 1.0) : 1.0);
    
    // Calculate next 5 GW xP
    const next5GWXP = ppg * gameweeks * formFactor * minutesFactor * setpieceFactor * fixtureFactor;
    
    // Confidence based on data quality
    const confidence = Math.min(1, (minutesFactor * 0.4 + (form > 0 ? 0.4 : 0) + 0.2));
    
    return {
      playerId: player.id,
      playerName: player.web_name,
      team: team?.short_name || 'UNK',
      position: positionName,
      nextGW: Math.round(nextGWXP * 10) / 10,
      next5GW: Math.round(next5GWXP * 10) / 10,
      confidence,
      breakdown: {
        formFactor: Math.round(formFactor * 100) / 100,
        fixtureFactor: Math.round(fixtureFactor * 100) / 100,
        minutesFactor: Math.round(minutesFactor * 100) / 100,
        setpieceFactor: Math.round(setpieceFactor * 100) / 100,
      },
    };
  }

  // Evaluate a transfer
  evaluateTransfer(
    playerOutId: number,
    playerInId: number,
    freeTransfers: number,
    horizon: number = 8
  ): TransferRecommendation {
    const playerOut = this.players.get(playerOutId);
    const playerIn = this.players.get(playerInId);
    
    if (!playerOut || !playerIn) {
      throw new Error('Player not found');
    }
    
    const xpOut = this.calculateExpectedPoints(playerOutId, horizon);
    const xpIn = this.calculateExpectedPoints(playerInId, horizon);
    
    const xpGain = xpIn.next5GW - xpOut.next5GW;
    const hitCost = freeTransfers > 0 ? 0 : 4;
    const netGain = xpGain - hitCost;
    
    // Determine risk level
    let riskLevel: 'low' | 'medium' | 'high' = 'medium';
    const avgConfidence = (xpIn.confidence + xpOut.confidence) / 2;
    if (avgConfidence > 0.8 && netGain > 4) riskLevel = 'low';
    else if (avgConfidence < 0.5 || netGain < 0) riskLevel = 'high';
    
    // Generate reasoning
    let reasoning = '';
    if (hitCost > 0) {
      if (netGain > 8) {
        reasoning = `Strong hit: ${playerIn.web_name} projected to gain ${xpGain.toFixed(1)} pts over ${horizon} GWs, netting ${netGain.toFixed(1)} after -4 hit.`;
      } else if (netGain > 4) {
        reasoning = `Marginal hit: ${netGain.toFixed(1)} net gain is borderline. Consider waiting for free transfer.`;
      } else {
        reasoning = `Avoid hit: Only ${netGain.toFixed(1)} net gain doesn't justify -4 cost. Recommend waiting.`;
      }
    } else {
      if (xpGain > 2) {
        reasoning = `Free transfer: ${playerIn.web_name} offers ${xpGain.toFixed(1)} xP improvement over ${playerOut.web_name}.`;
      } else if (xpGain > 0) {
        reasoning = `Slight upgrade: Small ${xpGain.toFixed(1)} xP gain. Consider if there's a better option.`;
      } else {
        reasoning = `Not recommended: ${playerOut.web_name} has better fixtures. Consider banking the transfer.`;
      }
    }
    
    return {
      playerOut,
      playerIn,
      xpGain: Math.round(xpGain * 10) / 10,
      hitCost,
      netGain: Math.round(netGain * 10) / 10,
      horizon,
      confidence: avgConfidence,
      reasoning,
      riskLevel,
    };
  }

  // Hit threshold: Should we take a hit?
  shouldTakeHit(xpGain: number, horizon: number = 2): boolean {
    // Rule: Only take hit if xP gain > 8 over 2 GWs (or equivalent rate)
    const threshold = 8 * (horizon / 2);
    return xpGain > threshold;
  }

  // Evaluate chip timing
  evaluateChip(
    chip: 'wildcard' | 'freehit' | 'bboost' | '3xc',
    gameweek: number,
    squadPlayerIds: number[],
    benchPlayerIds: number[]
  ): ChipRecommendation {
    const gwFixtures = this.fixtures.filter(f => f.event === gameweek);
    const isDGW = this.isDGW(gameweek);
    const isBGW = this.isBGW(gameweek);
    
    let recommended = false;
    let expectedGain = 0;
    let reasoning = '';
    let confidence = 0.5;
    
    switch (chip) {
      case 'bboost': {
        // Bench Boost: Best in DGW with strong bench
        const benchXP = benchPlayerIds.reduce((sum, id) => {
          return sum + this.calculateExpectedPoints(id, 1).nextGW;
        }, 0);
        
        expectedGain = benchXP;
        recommended = isDGW && benchXP > 12;
        confidence = isDGW ? 0.8 : 0.4;
        reasoning = isDGW 
          ? `DGW${gameweek}: Bench expected ${benchXP.toFixed(1)} pts. ${recommended ? 'Recommended!' : 'Bench too weak.'}`
          : `Not a DGW. Save Bench Boost for double gameweek.`;
        break;
      }
      
      case '3xc': {
        // Triple Captain: Highest xP player in favorable DGW
        const squadXP = squadPlayerIds.map(id => ({
          id,
          xp: this.calculateExpectedPoints(id, 1).nextGW,
        }));
        const topPlayer = squadXP.sort((a, b) => b.xp - a.xp)[0];
        const topPlayerData = this.players.get(topPlayer.id);
        
        expectedGain = topPlayer.xp; // Extra captain points
        recommended = isDGW && topPlayer.xp > 12;
        confidence = isDGW ? 0.75 : 0.35;
        reasoning = isDGW
          ? `DGW${gameweek}: ${topPlayerData?.web_name} xP=${topPlayer.xp.toFixed(1)}. ${recommended ? 'Good TC target!' : 'No standout captaincy option.'}`
          : `Not a DGW. TC is best used in double gameweeks.`;
        break;
      }
      
      case 'freehit': {
        // Free Hit: Best in BGW or when squad has many blanks
        const playingPlayers = squadPlayerIds.filter(id => {
          const player = this.players.get(id);
          if (!player) return false;
          const teamFixtures = gwFixtures.filter(f => f.team_h === player.team || f.team_a === player.team);
          return teamFixtures.length > 0;
        });
        
        const nonPlayingCount = squadPlayerIds.length - playingPlayers.length;
        expectedGain = nonPlayingCount * 4; // Approximate points from having full XI
        recommended = isBGW && nonPlayingCount >= 5;
        confidence = isBGW ? 0.85 : 0.3;
        reasoning = isBGW
          ? `BGW${gameweek}: ${nonPlayingCount} players blanking. ${recommended ? 'Free Hit recommended!' : 'Squad copes well.'}`
          : `Not a BGW. Save Free Hit for blank gameweeks.`;
        break;
      }
      
      case 'wildcard': {
        // Wildcard: When squad needs major restructure (4+ transfers)
        // This is harder to evaluate without knowing desired moves
        expectedGain = 0;
        recommended = false;
        confidence = 0.5;
        reasoning = `Wildcard best used when 4+ transfers needed. Evaluate your squad needs.`;
        break;
      }
    }
    
    return {
      chip,
      recommended,
      gameweek,
      expectedGain: Math.round(expectedGain * 10) / 10,
      reasoning,
      confidence,
    };
  }

  // Helper methods
  getUpcomingFixtures(teamId: number, count: number): Fixture[] {
    const maxEvent = this.currentGW + count - 1;
    return this.fixtures
      .filter(f => 
        f.event !== null && 
        f.event >= this.currentGW && 
        f.event <= maxEvent &&
        (f.team_h === teamId || f.team_a === teamId)
      )
      .sort((a, b) => (a.event || 0) - (b.event || 0) || (a.kickoff_time || '').localeCompare(b.kickoff_time || '') || a.id - b.id);
  }

  private getNextFDR(fixture: Fixture, teamId: number): number {
    const isHome = fixture.team_h === teamId;
    return isHome ? fixture.team_a_difficulty : fixture.team_h_difficulty;
  }

  private getPositionName(elementType: number): string {
    const positions: Record<number, string> = {
      1: 'GKP',
      2: 'DEF',
      3: 'MID',
      4: 'FWD',
    };
    return positions[elementType] || 'UNK';
  }

  private isDGW(gameweek: number): boolean {
    // Count fixtures per team in this GW
    const gwFixtures = this.fixtures.filter(f => f.event === gameweek);
    const teamCounts = new Map<number, number>();
    
    gwFixtures.forEach(f => {
      teamCounts.set(f.team_h, (teamCounts.get(f.team_h) || 0) + 1);
      teamCounts.set(f.team_a, (teamCounts.get(f.team_a) || 0) + 1);
    });
    
    // DGW if any team has 2+ fixtures
    return Array.from(teamCounts.values()).some(count => count >= 2);
  }

  private isBGW(gameweek: number): boolean {
    // BGW if fewer than 10 fixtures (20 teams = 10 fixtures normally)
    const gwFixtures = this.fixtures.filter(f => f.event === gameweek);
    return gwFixtures.length < 10;
  }

  // Get player by ID
  getPlayer(id: number): Player | undefined {
    return this.players.get(id);
  }

  // Get team by ID
  getTeam(id: number): Team | undefined {
    return this.teams.get(id);
  }

  // Get current gameweek
  getCurrentGameweek(): number {
    return this.currentGW;
  }

  // Get all gameweeks (for deadline access)
  getGameweeks(): Gameweek[] {
    return this.gameweeks;
  }

  // Get next deadline information
  getNextDeadline(): { gameweek: number; deadline: Date; hoursRemaining: number } | null {
    const now = new Date();
    
    // Find the next upcoming deadline
    const nextGW = this.gameweeks.find(gw => {
      const deadline = new Date(gw.deadline_time);
      return deadline > now && !gw.finished;
    });
    
    if (!nextGW) {
      return null;
    }
    
    const deadline = new Date(nextGW.deadline_time);
    const hoursRemaining = (deadline.getTime() - now.getTime()) / (1000 * 60 * 60);
    
    return {
      gameweek: nextGW.id,
      deadline,
      hoursRemaining,
    };
  }

  // Find player by name (fuzzy)
  findPlayerByName(name: string): Player | undefined {
    const searchLower = name.toLowerCase();
    
    // Exact match first
    for (const player of this.players.values()) {
      if (player.web_name.toLowerCase() === searchLower) {
        return player;
      }
    }
    
    // Partial match
    for (const player of this.players.values()) {
      if (player.web_name.toLowerCase().includes(searchLower) ||
          `${player.first_name} ${player.second_name}`.toLowerCase().includes(searchLower)) {
        return player;
      }
    }
    
    return undefined;
  }

  // Get top players by position
  getTopPlayersByPosition(position: number, count: number = 10): Player[] {
    return Array.from(this.players.values())
      .filter(p => p.element_type === position && p.status === 'a')
      .sort((a, b) => b.total_points - a.total_points)
      .slice(0, count);
  }

  // Get trending transfers
  getTrendingTransfersIn(count: number = 10): Player[] {
    return Array.from(this.players.values())
      .sort((a, b) => b.transfers_in_event - a.transfers_in_event)
      .slice(0, count);
  }

  getTrendingTransfersOut(count: number = 10): Player[] {
    return Array.from(this.players.values())
      .sort((a, b) => b.transfers_out_event - a.transfers_out_event)
      .slice(0, count);
  }

  // Get price risers/fallers
  getPriceRisers(count: number = 10): Player[] {
    return Array.from(this.players.values())
      .filter(p => p.cost_change_event > 0)
      .sort((a, b) => b.cost_change_event - a.cost_change_event)
      .slice(0, count);
  }

  getPriceFallers(count: number = 10): Player[] {
    return Array.from(this.players.values())
      .filter(p => p.cost_change_event < 0)
      .sort((a, b) => a.cost_change_event - b.cost_change_event)
      .slice(0, count);
  }

  /**
   * Predict price change based on transfer velocity
   * Uses net transfers and ownership thresholds
   */
  predictPriceChange(playerId: number): {
    player: string;
    currentPrice: string;
    prediction: 'rise' | 'fall' | 'stable';
    confidence: number;
    reasoning: string;
    netTransfers: number;
    transferVelocity: number; // transfers per hour estimate
  } {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error(`Player ${playerId} not found`);
    }

    const netTransfers = player.transfers_in_event - player.transfers_out_event;
    const ownership = parseFloat(player.selected_by_percent) || 0;
    
    // Transfer velocity thresholds (rough estimates based on FPL patterns)
    // Price changes typically happen when net transfers reach ~0.1% ownership
    const totalManagers = 10000000; // Approximate total FPL managers
    const currentOwners = Math.floor(totalManagers * ownership / 100);
    const velocityThreshold = Math.max(10000, currentOwners * 0.02); // 2% of current owners
    
    // Calculate velocity score (-1 to 1)
    const velocityScore = Math.max(-1, Math.min(1, netTransfers / velocityThreshold));
    
    let prediction: 'rise' | 'fall' | 'stable' = 'stable';
    let confidence = 0.3;
    let reasoning = '';
    
    if (velocityScore > 0.5) {
      prediction = 'rise';
      confidence = Math.min(0.9, 0.5 + velocityScore * 0.4);
      reasoning = `High transfer-in velocity (${netTransfers.toLocaleString()} net). Price rise likely.`;
    } else if (velocityScore < -0.5) {
      prediction = 'fall';
      confidence = Math.min(0.9, 0.5 + Math.abs(velocityScore) * 0.4);
      reasoning = `High transfer-out velocity (${Math.abs(netTransfers).toLocaleString()} net out). Price fall likely.`;
    } else {
      prediction = 'stable';
      confidence = 0.6;
      reasoning = `Transfer activity within normal range. Price likely stable.`;
    }
    
    // Adjust for ownership-based factors
    if (ownership > 50 && prediction === 'rise') {
      confidence *= 0.8;
      reasoning += ' High ownership may slow rise.';
    }
    if (ownership < 5 && prediction === 'rise') {
      confidence *= 1.1;
      reasoning += ' Low ownership allows faster rise.';
    }
    
    return {
      player: player.web_name,
      currentPrice: `£${(player.now_cost / 10).toFixed(1)}m`,
      prediction,
      confidence: Math.min(1, confidence),
      reasoning,
      netTransfers,
      transferVelocity: Math.round(netTransfers / 24), // Per hour assuming GW event
    };
  }

  /**
   * Calculate Effective Ownership for a player
   * EO = ownership * captain_factor * chip_factor
   */
  calculateEffectiveOwnership(playerId: number, isCaptain: boolean = false): {
    player: string;
    ownership: number;
    effectiveOwnership: number;
    captainRate: number;
    reasoning: string;
  } {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error(`Player ${playerId} not found`);
    }

    const ownership = parseFloat(player.selected_by_percent) || 0;
    
    // Estimate captain rate based on xP ranking among owned players
    // Top players have higher captain rates
    const xp = this.calculateExpectedPoints(playerId, 1);
    const allPlayersXP = Array.from(this.players.values())
      .filter(p => parseFloat(p.selected_by_percent) > 5)
      .map(p => ({
        id: p.id,
        xp: this.calculateExpectedPoints(p.id, 1).nextGW,
        ownership: parseFloat(p.selected_by_percent),
      }))
      .sort((a, b) => b.xp * b.ownership - a.xp * a.ownership);
    
    const rank = allPlayersXP.findIndex(p => p.id === playerId) + 1;
    
    // Estimate captain rate: top 1 gets ~30%, top 5 get ~10-20%, rest get <5%
    let captainRate = 0;
    if (rank === 1) captainRate = 30;
    else if (rank <= 3) captainRate = 15;
    else if (rank <= 5) captainRate = 8;
    else if (rank <= 10) captainRate = 3;
    else if (rank <= 20) captainRate = 1;
    else captainRate = 0.5;
    
    // Scale captain rate by ownership (can't captain more than you own)
    captainRate = Math.min(captainRate, ownership * 0.5);
    
    // EO = ownership + captain_rate (since captains score 2x)
    const effectiveOwnership = ownership + captainRate;
    
    let reasoning = '';
    if (isCaptain) {
      if (captainRate > 10) {
        reasoning = `Popular captain choice (${captainRate.toFixed(1)}%). Gains limited against field.`;
      } else {
        reasoning = `Differential captain (${captainRate.toFixed(1)}%). Good for rank gains if he hauls.`;
      }
    } else {
      if (effectiveOwnership > 100) {
        reasoning = `Must-have. Missing him costs points against field.`;
      } else if (effectiveOwnership > 50) {
        reasoning = `Template pick. Safe to own.`;
      } else {
        reasoning = `Differential. Can gain/lose rank on him.`;
      }
    }
    
    return {
      player: player.web_name,
      ownership: Math.round(ownership * 10) / 10,
      effectiveOwnership: Math.round(effectiveOwnership * 10) / 10,
      captainRate: Math.round(captainRate * 10) / 10,
      reasoning,
    };
  }

  /**
   * Get alternative captain suggestions ranked by xP and EO differential value
   */
  getAlternativeCaptains(squadPlayerIds: number[], topN: number = 5): {
    rank: number;
    player: string;
    team: string;
    xpNextGW: number;
    xpDGW: number;
    ownership: number;
    effectiveOwnership: number;
    differentialScore: number;
    recommendation: string;
  }[] {
    interface CaptainCandidate {
      id: number;
      player: string;
      team: string;
      xpNextGW: number;
      xpDGW: number;
      ownership: number;
      effectiveOwnership: number;
      differentialScore: number;
      isDGW: boolean;
    }

    const candidates: CaptainCandidate[] = squadPlayerIds.map(id => {
      const player = this.players.get(id);
      if (!player) return null;
      
      const xp = this.calculateExpectedPoints(id, 1);
      const eo = this.calculateEffectiveOwnership(id, true);
      
      // Differential score: higher xP with lower EO = better differential
      // Score = xP * (100 - EO) / 50
      const differentialScore = xp.nextGW * (100 - eo.effectiveOwnership) / 50;
      
      // Check for DGW
      const teamFixtures = this.fixtures.filter(f => 
        f.event === this.currentGW && 
        (f.team_h === player.team || f.team_a === player.team)
      );
      const isDGW = teamFixtures.length >= 2;
      
      return {
        id,
        player: player.web_name,
        team: this.teams.get(player.team)?.short_name || 'UNK',
        xpNextGW: xp.nextGW,
        xpDGW: isDGW ? xp.nextGW * 1.8 : xp.nextGW, // Approximate DGW boost
        ownership: eo.ownership,
        effectiveOwnership: eo.effectiveOwnership,
        differentialScore: Math.round(differentialScore * 10) / 10,
        isDGW,
      };
    }).filter((c): c is CaptainCandidate => c !== null);
    
    // Sort by xP first, then use differential as tiebreaker
    const sorted = candidates.sort((a: CaptainCandidate, b: CaptainCandidate) => {
      const xpDiff = b.xpNextGW - a.xpNextGW;
      if (Math.abs(xpDiff) > 0.5) return xpDiff;
      return b.differentialScore - a.differentialScore;
    });
    
    return sorted.slice(0, topN).map((c: CaptainCandidate, i: number) => ({
      rank: i + 1,
      player: c.player,
      team: c.team,
      xpNextGW: c.xpNextGW,
      xpDGW: c.xpDGW,
      ownership: c.ownership,
      effectiveOwnership: c.effectiveOwnership,
      differentialScore: c.differentialScore,
      recommendation: i === 0 
        ? 'Best captain choice by xP'
        : c.differentialScore > sorted[0].differentialScore 
          ? 'Best differential pick'
          : c.isDGW 
            ? 'DGW player - consider TC'
            : 'Alternative option',
    }));
  }

  /**
   * Get all players from the cache
   */
  getAllPlayers(): Player[] {
    return Array.from(this.players.values());
  }
}

// Singleton instance
let engineInstance: OptimizationEngine | null = null;

export async function getOptimizationEngine(): Promise<OptimizationEngine> {
  if (!engineInstance) {
    engineInstance = new OptimizationEngine();
    await engineInstance.initialize();
  }
  return engineInstance;
}

export function resetOptimizationEngine(): void {
  engineInstance = null;
}

export { OptimizationEngine };
