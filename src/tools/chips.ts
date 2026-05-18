// Play Chip Tool - Activate chips with timing validation
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';

export const playChipTool = tool({
  name: 'play_chip',
  description: 'Evaluate and play a chip (Wildcard, Free Hit, Bench Boost, Triple Captain). Shows optimal timing analysis and requires confirmation. Chips can be used twice per season (once per half).',
  parameters: z.object({
    chip: z.enum(['wildcard', 'freehit', 'bboost', '3xc']).describe('Chip to evaluate/play'),
    confirm: z.boolean().default(false).describe('Set to true to play the chip. First call without confirm to see analysis.'),
  }),
  execute: async ({ chip, confirm }) => {
    const client = getFPLClient();
    const engine = await getOptimizationEngine();
    const currentGW = engine.getCurrentGameweek();
    
    // Map chip names
    const chipNames: Record<string, string> = {
      wildcard: 'Wildcard',
      freehit: 'Free Hit',
      bboost: 'Bench Boost',
      '3xc': 'Triple Captain',
    };
    
    // Get available chips and current squad
    let availableChips: string[] = [];
    let usedChips: { name: string; gameweeks: number[] }[] = [];
    let squadPlayerIds: number[] = [];
    let benchPlayerIds: number[] = [];
    
    if (client.isAuthenticated()) {
      try {
        const myTeam = await client.getMyTeam();
        
        availableChips = myTeam.chips
          .filter(c => c.status_for_entry === 'available')
          .map(c => c.name);
        
        usedChips = myTeam.chips
          .filter(c => c.status_for_entry === 'played')
          .map(c => ({
            name: c.name,
            gameweeks: c.played_by_entry,
          }));
        
        squadPlayerIds = myTeam.picks
          .filter(p => p.position <= 11)
          .map(p => p.element);
        
        benchPlayerIds = myTeam.picks
          .filter(p => p.position > 11)
          .map(p => p.element);
        
        // Check if chip is available
        const chipApiName = chip === '3xc' ? '3xc' : chip;
        if (!availableChips.includes(chipApiName) && !availableChips.includes(chip)) {
          const usedInfo = usedChips.find(c => c.name === chipApiName || c.name === chip);
          return {
            error: `${chipNames[chip]} is not available.`,
            usedIn: usedInfo ? `Already used in GW${usedInfo.gameweeks.join(', GW')}` : 'Unknown',
            availableChips,
            hint: 'Remember: Each chip can be used twice per season (once per half).',
          };
        }
      } catch (error) {
        return {
          error: 'Failed to fetch team data. Authentication may be required.',
        };
      }
    } else {
      return {
        error: 'Authentication required to check and play chips.',
        hint: 'Please provide your FPL credentials.',
      };
    }
    
    // Evaluate chip timing
    const evaluation = engine.evaluateChip(
      chip as 'wildcard' | 'freehit' | 'bboost' | '3xc',
      currentGW,
      squadPlayerIds,
      benchPlayerIds
    );
    
    // Get additional context based on chip type
    let additionalInfo: Record<string, unknown> = {};
    
    if (chip === 'bboost') {
      // Show bench player details
      const benchDetails = benchPlayerIds.map(id => {
        const player = engine.getPlayer(id);
        const xp = player ? engine.calculateExpectedPoints(id, 1) : null;
        return {
          name: player?.web_name || 'Unknown',
          team: player ? engine.getTeam(player.team)?.short_name : 'UNK',
          xpNextGW: xp?.nextGW || 0,
        };
      });
      additionalInfo.benchPlayers = benchDetails;
      additionalInfo.totalBenchXP = benchDetails.reduce((sum, p) => sum + p.xpNextGW, 0);
    }
    
    if (chip === '3xc') {
      // Show captain options
      const captainOptions = squadPlayerIds
        .map(id => {
          const player = engine.getPlayer(id);
          const xp = player ? engine.calculateExpectedPoints(id, 1) : null;
          return {
            name: player?.web_name || 'Unknown',
            team: player ? engine.getTeam(player.team)?.short_name : 'UNK',
            xpNextGW: xp?.nextGW || 0,
          };
        })
        .sort((a, b) => b.xpNextGW - a.xpNextGW)
        .slice(0, 5);
      additionalInfo.topCaptainOptions = captainOptions;
    }
    
    const analysis = {
      chip: chipNames[chip],
      gameweek: currentGW,
      recommendation: {
        shouldPlay: evaluation.recommended,
        expectedGain: evaluation.expectedGain,
        confidence: `${(evaluation.confidence * 100).toFixed(0)}%`,
        reasoning: evaluation.reasoning,
      },
      chipStatus: {
        available: availableChips,
        used: usedChips,
      },
      ...additionalInfo,
    };
    
    // If not confirmed, return analysis only
    if (!confirm) {
      return {
        status: 'ANALYSIS_ONLY',
        message: `Review the ${chipNames[chip]} analysis. Call again with confirm=true to activate.`,
        ...analysis,
        warning: !evaluation.recommended
          ? `Not recommended this gameweek. ${evaluation.reasoning}`
          : undefined,
      };
    }
    
    return {
      status: 'MANUAL_REQUIRED',
      message: `${chipNames[chip]} was not activated automatically. Activate it manually on the FPL website after reviewing this analysis.`,
      ...analysis,
    };
  },
});
