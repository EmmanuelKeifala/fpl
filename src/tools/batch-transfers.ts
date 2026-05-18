// Batch Transfers Tool - Make multiple transfers at once
import { z } from 'zod';
import { tool } from '@openai/agents';
import { getFPLClient } from '../api/client.js';
import { getOptimizationEngine } from '../engine/optimizer.js';
import { logDecision } from '../db/client.js';

const transferSchema = z.object({
  out: z.string().describe('Player to sell'),
  in: z.string().describe('Player to buy'),
});

export const batchTransfersTool = tool({
  name: 'batch_transfers',
  description: 'Plan and execute multiple transfers at once. Useful for wildcard or when making several changes. Shows combined analysis and total hit cost.',
  parameters: z.object({
    transfers: z.array(transferSchema).min(1).max(15).describe('Array of transfers, each with "out" and "in" player names'),
    useWildcard: z.boolean().default(false).describe('Set true to use Wildcard chip (no hit cost)'),
    confirm: z.boolean().default(false).describe('Set true to execute all transfers'),
  }),
  execute: async ({ transfers, useWildcard, confirm }) => {
    const client = getFPLClient();
    const engine = await getOptimizationEngine();
    
    if (!client.isAuthenticated()) {
      return {
        error: 'Authentication required for transfers.',
        hint: 'Please provide FPL credentials.',
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
    
    const freeTransfers = myTeam.transfers.limit - myTeam.transfers.made;
    let bank = myTeam.transfers.bank;
    
    // Build current squad state
    const currentSquad = new Map<number, number>(); // playerId -> teamId
    const sellingPrices = new Map<number, number>();
    const squadByTeam = new Map<number, Set<number>>(); // teamId -> playerIds
    
    myTeam.picks.forEach(pick => {
      const player = engine.getPlayer(pick.element);
      if (player) {
        currentSquad.set(pick.element, player.team);
        sellingPrices.set(pick.element, pick.selling_price ?? player.now_cost);
        const teamPlayers = squadByTeam.get(player.team) || new Set();
        teamPlayers.add(pick.element);
        squadByTeam.set(player.team, teamPlayers);
      }
    });
    
    // Validate and analyze each transfer
    const validatedTransfers: {
      outPlayer: ReturnType<typeof engine.getPlayer>;
      inPlayer: ReturnType<typeof engine.getPlayer>;
      xpGain: number;
      priceChange: number;
    }[] = [];
    
    const errors: string[] = [];
    let totalXPGain = 0;
    let totalPriceChange = 0;
    
    for (let i = 0; i < transfers.length; i++) {
      const t = transfers[i];
      const outPlayer = engine.findPlayerByName(t.out);
      const inPlayer = engine.findPlayerByName(t.in);
      
      if (!outPlayer) {
        errors.push(`Transfer ${i + 1}: Cannot find player "${t.out}" to sell`);
        continue;
      }
      
      if (!inPlayer) {
        errors.push(`Transfer ${i + 1}: Cannot find player "${t.in}" to buy`);
        continue;
      }
      
      // Check if out player is in squad (considering previous transfers)
      const outInSquad = currentSquad.has(outPlayer.id);
      if (!outInSquad) {
        errors.push(`Transfer ${i + 1}: ${outPlayer.web_name} is not in your squad`);
        continue;
      }
      
      if (outPlayer.id === inPlayer.id) {
        errors.push(`Transfer ${i + 1}: Cannot transfer ${outPlayer.web_name} to himself`);
        continue;
      }
      
      if (currentSquad.has(inPlayer.id)) {
        errors.push(`Transfer ${i + 1}: ${inPlayer.web_name} is already in your squad`);
        continue;
      }
      
      // Check position match
      if (outPlayer.element_type !== inPlayer.element_type) {
        errors.push(`Transfer ${i + 1}: ${outPlayer.web_name} and ${inPlayer.web_name} are different positions`);
        continue;
      }
      
      // Check team limit after this transfer
      const inPlayerTeam = inPlayer.team;
      const outPlayerTeam = outPlayer.team;
      const currentTeamCount = squadByTeam.get(inPlayerTeam)?.size || 0;
      const removing = inPlayerTeam === outPlayerTeam ? 1 : 0;
      
      if (currentTeamCount - removing >= 3) {
        const teamName = engine.getTeam(inPlayerTeam)?.name || 'that team';
        errors.push(`Transfer ${i + 1}: Would exceed 3 players from ${teamName}`);
        continue;
      }
      
      // Check budget
      const priceChange = (sellingPrices.get(outPlayer.id) ?? outPlayer.now_cost) - inPlayer.now_cost;
      if (bank + priceChange < 0) {
        errors.push(`Transfer ${i + 1}: Insufficient funds to buy ${inPlayer.web_name}`);
        continue;
      }
      
      // Calculate xP gain
      const outXP = engine.calculateExpectedPoints(outPlayer.id, 5);
      const inXP = engine.calculateExpectedPoints(inPlayer.id, 5);
      const xpGain = inXP.next5GW - outXP.next5GW;
      
      // Update state for next transfer validation
      currentSquad.delete(outPlayer.id);
      currentSquad.set(inPlayer.id, inPlayer.team);
      sellingPrices.delete(outPlayer.id);
      sellingPrices.set(inPlayer.id, inPlayer.now_cost);
      
      const outTeamPlayers = squadByTeam.get(outPlayerTeam);
      if (outTeamPlayers) {
        outTeamPlayers.delete(outPlayer.id);
      }
      
      const inTeamPlayers = squadByTeam.get(inPlayerTeam) || new Set();
      inTeamPlayers.add(inPlayer.id);
      squadByTeam.set(inPlayerTeam, inTeamPlayers);
      
      bank += priceChange;
      totalXPGain += xpGain;
      totalPriceChange += priceChange;
      
      validatedTransfers.push({
        outPlayer,
        inPlayer,
        xpGain,
        priceChange,
      });
    }
    
    if (errors.length > 0 && validatedTransfers.length === 0) {
      return {
        error: 'All transfers failed validation',
        errors,
      };
    }
    
    // Calculate hit cost
    const extraTransfers = Math.max(0, validatedTransfers.length - freeTransfers);
    const hitCost = useWildcard ? 0 : extraTransfers * 4;
    const netXPGain = totalXPGain - hitCost;
    
    const analysis = {
      transfers: validatedTransfers.map((t, i) => ({
        number: i + 1,
        out: {
          name: t.outPlayer!.web_name,
          team: engine.getTeam(t.outPlayer!.team)?.short_name,
          price: `£${(t.outPlayer!.now_cost / 10).toFixed(1)}m`,
        },
        in: {
          name: t.inPlayer!.web_name,
          team: engine.getTeam(t.inPlayer!.team)?.short_name,
          price: `£${(t.inPlayer!.now_cost / 10).toFixed(1)}m`,
        },
        xpGain: Math.round(t.xpGain * 10) / 10,
      })),
      summary: {
        totalTransfers: validatedTransfers.length,
        freeTransfers,
        extraTransfers,
        hitCost: useWildcard ? 'None (Wildcard)' : hitCost,
        totalXPGain: Math.round(totalXPGain * 10) / 10,
        netXPGain: Math.round(netXPGain * 10) / 10,
        bankAfter: `£${(bank / 10).toFixed(1)}m`,
        usingWildcard: useWildcard,
      },
      errors: errors.length > 0 ? errors : undefined,
      recommendation: netXPGain > 0 ? 'APPROVE' : 'CAUTION - Net negative expected value',
    };
    
    if (!confirm) {
      return {
        status: 'ANALYSIS_ONLY',
        message: `Analyzed ${validatedTransfers.length} transfers. Call again with confirm=true to execute.`,
        ...analysis,
        warning: hitCost > 0 && netXPGain < 0
          ? 'This set of transfers has negative expected value after hits.'
          : undefined,
      };
    }
    
    // Execute transfers (in reality, FPL requires specific API calls)
    const currentGW = engine.getCurrentGameweek();
    
    // Log the batch decision
    await logDecision({
      gameweek: currentGW,
      decisionType: 'transfer',
      action: JSON.stringify({
        type: 'batch',
        transfers: validatedTransfers.map(t => ({
          out: t.outPlayer!.web_name,
          in: t.inPlayer!.web_name,
        })),
        usedWildcard: useWildcard,
      }),
      reasoning: `Batch transfer: ${validatedTransfers.length} moves, net xP: ${netXPGain.toFixed(1)}`,
      expectedPoints: totalXPGain,
      rankBefore: null,
      hitsTaken: extraTransfers,
    });
    
    return {
      status: 'MANUAL_REQUIRED',
      message: `${validatedTransfers.length} transfers analyzed and logged. They were not executed automatically; execute them on the FPL website to confirm.`,
      ...analysis,
      note: 'Automatic batch transfer execution requires a verified FPL transfer payload and is disabled for safety.',
    };
  },
});
