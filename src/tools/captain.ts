// Set Captain Tool - Change captain and vice-captain
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';

export const setCaptainTool = tool({
  name: 'set_captain',
  description: 'Analyze a captain and optional vice-captain choice. This tool never submits changes to FPL.',
  parameters: z.object({
    captain: z.string().describe('Name of player to set as captain'),
    viceCaptain: z.string().default('').describe('Name of player to set as vice-captain (leave empty to keep current)'),
    confirm: z.boolean().default(false).describe('Set true to return a manual-action summary after the analysis'),
  }),
  execute: async ({ captain, viceCaptain, confirm }) => {
    const client = getFPLClient();
    const engine = await getOptimizationEngine();
    
    if (!client.isAuthenticated()) {
      return {
        error: 'Authentication required to analyze your squad captaincy.',
        hint: 'Please provide FPL credentials in .env file.',
      };
    }
    
    // Get current team
    let myTeam;
    try {
      myTeam = await client.getMyTeam();
    } catch (error) {
      return {
        error: 'Failed to fetch your team.',
      };
    }
    
    // Find captain in squad
    const squadPlayerIds = myTeam.picks.map(p => p.element);
    const captainPlayer = engine.findPlayerByName(captain);
    
    if (!captainPlayer) {
      return {
        error: `Could not find player "${captain}".`,
      };
    }
    
    if (!squadPlayerIds.includes(captainPlayer.id)) {
      return {
        error: `${captainPlayer.web_name} is not in your squad.`,
        yourSquad: squadPlayerIds.map(id => engine.getPlayer(id)?.web_name || 'Unknown'),
      };
    }
    
    // Find vice captain if specified
    let viceCaptainPlayer = null;
    if (viceCaptain) {
      viceCaptainPlayer = engine.findPlayerByName(viceCaptain);
      if (!viceCaptainPlayer) {
        return {
          error: `Could not find vice-captain "${viceCaptain}".`,
        };
      }
      if (!squadPlayerIds.includes(viceCaptainPlayer.id)) {
        return {
          error: `${viceCaptainPlayer.web_name} is not in your squad.`,
        };
      }
      if (viceCaptainPlayer.id === captainPlayer.id) {
        return {
          error: 'Captain and vice-captain must be different players.',
        };
      }
    }
    
    // Calculate xP for captain and alternatives
    const captainXP = engine.calculateExpectedPoints(captainPlayer.id, 1);
    
    // Get alternative captain suggestions (top 5 by xP)
    const alternatives = squadPlayerIds
      .filter(id => id !== captainPlayer.id)
      .map(id => {
        const player = engine.getPlayer(id);
        const xp = engine.calculateExpectedPoints(id, 1);
        return {
          id,
          name: player?.web_name || 'Unknown',
          team: player ? engine.getTeam(player.team)?.short_name : 'UNK',
          xpNextGW: xp.nextGW,
          form: player?.form || '0.0',
          effectiveOwnership: parseFloat(player?.selected_by_percent || '0'),
        };
      })
      .sort((a, b) => b.xpNextGW - a.xpNextGW)
      .slice(0, 5);
    
    // Find current captain
    const currentCaptainPick = myTeam.picks.find(p => p.is_captain);
    const currentCaptain = currentCaptainPick 
      ? engine.getPlayer(currentCaptainPick.element)?.web_name 
      : 'Unknown';
    
    const currentVCPick = myTeam.picks.find(p => p.is_vice_captain);
    const currentVC = currentVCPick 
      ? engine.getPlayer(currentVCPick.element)?.web_name 
      : 'Unknown';
    
    const analysis = {
      proposedCaptain: {
        name: captainPlayer.web_name,
        team: engine.getTeam(captainPlayer.team)?.short_name || 'UNK',
        xpNextGW: captainXP.nextGW,
        xpDoubled: captainXP.nextGW * 2,
        form: captainPlayer.form,
        ownership: `${captainPlayer.selected_by_percent}%`,
      },
      proposedViceCaptain: viceCaptainPlayer ? {
        name: viceCaptainPlayer.web_name,
        team: engine.getTeam(viceCaptainPlayer.team)?.short_name || 'UNK',
        xpNextGW: engine.calculateExpectedPoints(viceCaptainPlayer.id, 1).nextGW,
      } : null,
      current: {
        captain: currentCaptain,
        viceCaptain: currentVC,
      },
      alternatives,
      recommendation: alternatives[0]?.xpNextGW > captainXP.nextGW
        ? `Consider ${alternatives[0].name} instead (${alternatives[0].xpNextGW} xP vs ${captainXP.nextGW} xP)`
        : 'Good choice!',
    };
    
    if (!confirm) {
      return {
        status: 'ANALYSIS_ONLY',
        message: 'Review captain analysis. Call again with confirm=true for a manual-action summary.',
        ...analysis,
      };
    }
    
    return {
      status: 'MANUAL_REQUIRED',
      message: `Set ${captainPlayer.web_name}${viceCaptainPlayer ? ` and vice-captain ${viceCaptainPlayer.web_name}` : ''} manually on the FPL website. No FPL or database state was changed.`,
      ...analysis,
    };
  },
});
