import type { Player } from '../api/types.js';
import type { NewsItem } from './news.js';

export type PlayerNewsSignalType = 'injured' | 'doubtful' | 'ruled-out' | 'suspended' | 'expected-start' | 'expected-bench' | 'returning';

export interface PlayerNewsSignal {
  gameweek: number;
  playerId: number;
  playerName: string;
  type: PlayerNewsSignalType;
  source: string;
  sourceTier: 1 | 2 | 3 | 4;
  confidence: number;
  /** Availability for the target gameweek. This is applied once, separately
   * from minutes conditional on appearing. */
  availabilityProbability: number | null;
  minutesMultiplier: number;
  expectedMinutesFloor: number | null;
  confirmedLineup: boolean;
  conflicted: boolean;
  publishedAt: Date | null;
  retrievedAt: Date;
  expiresAt: Date;
  evidence: string;
  timestampVerified: boolean;
}

const TRUSTED_REPORTERS = new Set(['bencrellin', 'premierleague', 'livefpl']);
const ESTABLISHED_ANALYSTS = new Set(['fplfran', 'fpl review', 'thefplgeneral', 'fpltips']);

export function buildOfficialNewsSignals(players: Player[], gameweek: number, deadline: Date): PlayerNewsSignal[] {
  const now = new Date();
  return players.flatMap(player => {
    const chance = player.chance_of_playing_next_round;
    let type: PlayerNewsSignalType | undefined;
    let multiplier = 1;
    let availabilityProbability: number | null = null;
    if (player.status === 's') {
      type = 'suspended';
      availabilityProbability = 0;
    } else if (player.status === 'i' || player.status === 'u') {
      type = 'ruled-out';
      availabilityProbability = 0;
    } else if (player.status === 'd' || (chance !== null && chance < 100)) {
      type = 'doubtful';
      availabilityProbability = Math.max(0, Math.min(1, (chance ?? 50) / 100));
    } else if (player.news && /return|available|fit/i.test(player.news)) {
      type = 'returning';
      availabilityProbability = 1;
    }
    if (!type) return [];
    return [{
      gameweek,
      playerId: player.id,
      playerName: player.web_name,
      type,
      source: 'Official FPL',
      sourceTier: 1 as const,
      confidence: 0.98,
      availabilityProbability,
      minutesMultiplier: multiplier,
      expectedMinutesFloor: null,
      confirmedLineup: false,
      conflicted: false,
      publishedAt: player.news_added ? new Date(player.news_added) : null,
      retrievedAt: now,
      expiresAt: deadline,
      evidence: player.news || `FPL status ${player.status}`,
      timestampVerified: Boolean(player.news_added),
    }];
  });
}

export function buildExternalNewsSignals(input: {
  items: NewsItem[];
  players: Player[];
  gameweek: number;
  deadline: Date;
  retrievedAt?: Date;
}): PlayerNewsSignal[] {
  const retrievedAt = input.retrievedAt ?? new Date();
  const signals: PlayerNewsSignal[] = [];
  for (const item of input.items) {
    if (item.timestampVerified && item.timestamp.getTime() > input.deadline.getTime()) continue;
    const player = resolvePlayer(item.playerInvolved ?? `${item.title} ${item.content}`, input.players);
    const type = classifySignal(`${item.title} ${item.content}`);
    if (!player || !type) continue;
    const sourceTier = sourceTierFor(item.source);
    const confidence = baseConfidence(sourceTier, item.timestampVerified, item.timestamp, retrievedAt);
    const confirmedLineup = item.timestampVerified
      && sourceTier <= 2
      && (type === 'expected-start' || type === 'expected-bench');
    signals.push({
      gameweek: input.gameweek,
      playerId: player.id,
      playerName: player.web_name,
      type,
      source: item.source,
      sourceTier,
      confidence,
      availabilityProbability: signalAvailability(type),
      minutesMultiplier: signalMultiplier(type, sourceTier, confidence),
      expectedMinutesFloor: confirmedLineup && type === 'expected-start' ? 60 : null,
      confirmedLineup,
      conflicted: false,
      publishedAt: item.timestampVerified ? item.timestamp : null,
      retrievedAt,
      expiresAt: input.deadline,
      evidence: item.content,
      timestampVerified: item.timestampVerified,
    });
  }
  return signals;
}

export function mergePlayerNewsSignals(signals: PlayerNewsSignal[]): PlayerNewsSignal[] {
  const byPlayer = new Map<number, PlayerNewsSignal[]>();
  for (const signal of signals) byPlayer.set(signal.playerId, [...(byPlayer.get(signal.playerId) ?? []), signal]);
  return [...byPlayer.values()].map(playerSignals => {
    const hardOfficial = playerSignals.find(signal =>
      signal.sourceTier === 1 && (signal.type === 'ruled-out' || signal.type === 'suspended')
    );
    if (hardOfficial) return hardOfficial;

    const freshLineupSignals = playerSignals
      .filter(signal => signal.confirmedLineup && isFreshLineupSignal(signal))
      .sort((left, right) =>
        right.confidence - left.confidence
        || (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0)
      );
    if (freshLineupSignals.length > 0) {
      const best = freshLineupSignals[0]!;
      const contradiction = freshLineupSignals.find(signal =>
        signal.type !== best.type && Math.abs(signal.confidence - best.confidence) < 0.15
      );
      if (contradiction) {
        return {
          ...best,
          type: 'doubtful',
          confidence: Math.min(best.confidence, contradiction.confidence, 0.6),
          availabilityProbability: 0.6,
          minutesMultiplier: 0.65,
          expectedMinutesFloor: null,
          confirmedLineup: false,
          conflicted: true,
          evidence: `Conflicting lineup reports: ${best.evidence} | ${contradiction.evidence}`,
        };
      }
      return best;
    }

    const ordered = [...playerSignals].sort((a, b) =>
      a.sourceTier - b.sourceTier || b.confidence - a.confidence || b.retrievedAt.getTime() - a.retrievedAt.getTime()
    );
    const best = ordered[0]!;
    const corroboration = playerSignals.filter(signal => signal.type === best.type && signal.source !== best.source).length;
    if (best.sourceTier >= 3 && corroboration === 0 && best.minutesMultiplier < 0.65) {
      return { ...best, minutesMultiplier: 0.65, confidence: Math.min(best.confidence, 0.6) };
    }
    return corroboration > 0 ? { ...best, confidence: Math.min(0.99, best.confidence + 0.08) } : best;
  });
}

function isFreshLineupSignal(signal: PlayerNewsSignal): boolean {
  if (!signal.timestampVerified || !signal.publishedAt) return false;
  const ageAtDeadline = signal.expiresAt.getTime() - signal.publishedAt.getTime();
  return ageAtDeadline >= 0 && ageAtDeadline <= 6 * 60 * 60_000;
}

function resolvePlayer(text: string, players: Player[]): Player | undefined {
  const normalized = normalize(text);
  const exact = players.filter(player => [
    player.web_name,
    `${player.first_name} ${player.second_name}`,
    player.second_name,
  ].some(name => containsPhrase(normalized, normalize(name))));
  return exact.length === 1 ? exact[0] : undefined;
}

function containsPhrase(text: string, phrase: string): boolean {
  return phrase.length >= 3 && ` ${text} `.includes(` ${phrase} `);
}

function classifySignal(text: string): PlayerNewsSignalType | undefined {
  const value = text.toLowerCase();
  if (/suspend|ban(?:ned)?/.test(value)) return 'suspended';
  if (/ruled out|will miss|not available|absent|injured|injury setback/.test(value)) return 'ruled-out';
  if (/benched|on the bench|not start|dropped/.test(value)) return 'expected-bench';
  if (/expected to start|\bstarts\b|\bstarting\b|starting xi|named in (?:the )?(?:xi|line-?up)|in the line-?up|set to start/.test(value)) {
    return 'expected-start';
  }
  if (/doubt|fitness test|late call|50.?50/.test(value)) return 'doubtful';
  if (/return|available|passed fit|back in training|fit to play/.test(value)) return 'returning';
  return undefined;
}

function sourceTierFor(source: string): 1 | 2 | 3 | 4 {
  const handle = normalize(source.replace(/^twitter\/@?/i, ''));
  if (/official|premier league|club/.test(handle) || TRUSTED_REPORTERS.has(handle)) return 2;
  if (ESTABLISHED_ANALYSTS.has(handle)) return 3;
  return 4;
}

function baseConfidence(tier: number, verified: boolean, publishedAt: Date, now: Date): number {
  const base = tier === 2 ? 0.88 : tier === 3 ? 0.72 : 0.5;
  const ageHours = Math.max(0, now.getTime() - publishedAt.getTime()) / 3_600_000;
  const recency = Math.max(0.65, 1 - ageHours / 168);
  return Math.round(base * recency * (verified ? 1 : 0.7) * 100) / 100;
}

function signalMultiplier(type: PlayerNewsSignalType, tier: number, confidence: number): number {
  const target = type === 'expected-bench' ? 0.35 : 1;
  const effectiveConfidence = tier <= 2 ? confidence : Math.min(confidence, 0.65);
  return Math.round((1 - (1 - target) * effectiveConfidence) * 100) / 100;
}

function signalAvailability(type: PlayerNewsSignalType): number | null {
  if (type === 'ruled-out' || type === 'suspended') return 0;
  if (type === 'expected-start' || type === 'returning') return 1;
  if (type === 'expected-bench') return 0.8;
  if (type === 'doubtful') return 0.6;
  return null;
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
