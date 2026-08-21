// FPL API Client with Authentication
import { createHash } from 'node:crypto';
import type {
  BootstrapStatic,
  Fixture,
  ManagerEntry,
  ManagerHistory,
  ManagerPicks,
  MyTeam,
  Transfer,
  LiveGameweek,
  ClassicLeagueStandings,
  FPLSession,
  Player,
} from './types.js';
import { getValidTokens } from './auth.js';
import { assertNoForeignFileLock, withExclusiveFileLock } from '../scheduler/process-lock.js';
import { beginMutationOperation, updateMutationOperation } from '../db/client.js';
import { getMutationPermission } from '../scheduler/limits.js';
import { deriveSeasonLabel } from '../strategy/season.js';

const FPL_BASE_URL = 'https://fantasy.premierleague.com/api';

export const SESSION_SETUP_INSTRUCTIONS = [
  'FPL authentication is not configured. Set FPL_EMAIL and FPL_PASSWORD in .env.',
  'Alternatively, set FPL_BEARER_TOKEN to the access token stored by the Fantasy site.',
].join('\n');

export class FPLAuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FPLAuthError';
  }
}

export type AuthResult =
  | { authenticated: true; managerId: number }
  | { authenticated: false; reason: string };

interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  requiresAuth?: boolean;
}

export interface TransferRequest {
  playerOut: number;
  playerIn: number;
  purchasePrice: number;
  sellingPrice: number;
}

export interface TeamSelection {
  element: number;
  position: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
}

export interface MutationGuard {
  season: string;
  gameweek: number;
  deadlineAt: Date;
  safetyMarginMs: number;
  expectedManagerId: number;
  expectedTeamFingerprint: string;
}

export interface MutationResult {
  success: boolean;
  outcome: 'confirmed' | 'rejected' | 'unknown';
  message: string;
}

class FPLClient {
  private session: FPLSession | null = null;
  private bootstrapCache: { data: BootstrapStatic; timestamp: number } | null = null;
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour
  private lastAuthFailure: { at: Date; message: string } | null = null;
  private mutationQuarantineReason: string | null = null;
  private managerId?: number;
  private readonly expectedManagerId?: number;

  constructor(
    private cookie?: string,
    private bearerToken?: string,
    managerId?: number,
    expectedManagerId?: number
  ) {
    this.managerId = managerId;
    this.expectedManagerId = expectedManagerId ?? managerId;
  }

  /**
   * Establish a session from a browser-captured cookie (and optional API token),
   * then confirm it against /me/ so an expired session fails immediately instead
   * of at the deadline.
   */
  async authenticate(): Promise<AuthResult> {
    const cookie = this.cookie ?? process.env.FPL_COOKIE ?? process.env.FPL_SESSION_COOKIE;
    let bearerToken = this.bearerToken ?? process.env.FPL_BEARER_TOKEN;

    if (!cookie && !bearerToken) {
      try {
        bearerToken = (await getValidTokens())?.accessToken;
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'FPL login failed';
        this.lastAuthFailure = { at: new Date(), message: reason };
        return { authenticated: false, reason };
      }
    }

    if (!cookie && !bearerToken) {
      return { authenticated: false, reason: SESSION_SETUP_INSTRUCTIONS };
    }

    const normalizedCookie = (cookie ?? '')
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)
      .join('; ');

    this.session = {
      cookies: normalizedCookie,
      csrfToken: normalizedCookie.match(/csrftoken=([^;]+)/)?.[1] ?? '',
      managerId: this.managerId ?? 0,
      bearerToken,
    };

    let me: Awaited<ReturnType<FPLClient['getMe']>> | null = null;
    try {
      me = await this.getMe();
    } catch (error) {
      this.session = null;
      const reason = error instanceof Error ? error.message : 'Session validation failed';
      this.lastAuthFailure = { at: new Date(), message: reason };
      return { authenticated: false, reason };
    }

    // An unauthenticated request still returns 200 with a null player, so the
    // payload is the only reliable signal that the session actually works.
    if (!me?.player?.entry) {
      this.session = null;
      const reason = `FPL session is invalid or expired.\n${SESSION_SETUP_INSTRUCTIONS}`;
      this.lastAuthFailure = { at: new Date(), message: reason };
      return { authenticated: false, reason };
    }

    if (this.expectedManagerId && this.expectedManagerId !== me.player.entry) {
      this.session = null;
      const reason = `Authenticated manager ${me.player.entry} does not match expected manager ${this.expectedManagerId}`;
      this.lastAuthFailure = { at: new Date(), message: reason };
      return { authenticated: false, reason };
    }
    this.managerId = me.player.entry;
    this.session.managerId = this.managerId;
    this.lastAuthFailure = null;

    return { authenticated: true, managerId: this.managerId };
  }

  isAuthenticated(): boolean {
    return this.session !== null;
  }

  getLastAuthFailure(): { at: Date; message: string } | null {
    return this.lastAuthFailure;
  }

  private async fetch<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${FPL_BASE_URL}${endpoint}`;
    
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    };

    if (options.requiresAuth) {
      if (!this.session) {
        throw new FPLAuthError(`Authentication required. Call authenticate() first.\n${SESSION_SETUP_INSTRUCTIONS}`);
      }
      if (this.session.cookies) headers.Cookie = this.session.cookies;
      if (this.session.csrfToken) headers['X-CSRFToken'] = this.session.csrfToken;
      // Newer FPL clients carry the account token alongside the session cookie.
      if (this.session.bearerToken) {
        headers['X-Api-Authorization'] = `Bearer ${this.session.bearerToken}`;
      }
      headers.Referer = 'https://fantasy.premierleague.com/';
      headers.Origin = 'https://fantasy.premierleague.com';
    }

    if (options.method === 'POST' && options.body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      if (options.requiresAuth && (response.status === 401 || response.status === 403)) {
        // Keep the session in place: FPL returns transient 403s, and callers already
        // retry. Record the failure so the runner can alert on a genuinely dead session.
        const message = `FPL rejected an authenticated request (${response.status}). The session may have expired.\n${SESSION_SETUP_INSTRUCTIONS}`;
        this.lastAuthFailure = { at: new Date(), message };
        throw new FPLAuthError(message, response.status);
      }
      throw new Error(`FPL API error: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`FPL API returned invalid JSON for ${endpoint}`);
    }
  }

  // Public Endpoints (no auth required)
  
  async getBootstrapStatic(): Promise<BootstrapStatic> {
    // Use cache if valid
    if (this.bootstrapCache && Date.now() - this.bootstrapCache.timestamp < this.CACHE_TTL) {
      return this.bootstrapCache.data;
    }

    const data = await this.fetch<BootstrapStatic>('/bootstrap-static/');
    this.bootstrapCache = { data, timestamp: Date.now() };
    return data;
  }

  async getFixtures(gameweek?: number): Promise<Fixture[]> {
    const endpoint = gameweek ? `/fixtures/?event=${gameweek}` : '/fixtures/';
    return this.fetch<Fixture[]>(endpoint);
  }

  async getEntry(managerId: number): Promise<ManagerEntry> {
    return this.fetch<ManagerEntry>(`/entry/${managerId}/`);
  }

  async getEntryHistory(managerId: number): Promise<ManagerHistory> {
    return this.fetch<ManagerHistory>(`/entry/${managerId}/history/`);
  }

  async getEntryTransfers(managerId: number): Promise<Transfer[]> {
    return this.fetch<Transfer[]>(`/entry/${managerId}/transfers/`);
  }

  async getEntryPicks(managerId: number, gameweek: number): Promise<ManagerPicks> {
    return this.fetch<ManagerPicks>(`/entry/${managerId}/event/${gameweek}/picks/`);
  }

  async getLiveGameweek(gameweek: number): Promise<LiveGameweek> {
    return this.fetch<LiveGameweek>(`/event/${gameweek}/live/`);
  }

  async getClassicLeague(leagueId: number, page = 1): Promise<ClassicLeagueStandings> {
    return this.fetch<ClassicLeagueStandings>(
      `/leagues-classic/${leagueId}/standings/?page_standings=${page}`
    );
  }

  // Authenticated Endpoints

  async getMe(): Promise<{ player: { entry: number } | null }> {
    return this.fetch<{ player: { entry: number } | null }>('/me/', { requiresAuth: true });
  }

  async getMyTeam(): Promise<MyTeam> {
    if (!this.managerId) {
      throw new Error('Manager ID required');
    }
    return this.fetch<MyTeam>(`/my-team/${this.managerId}/`, { requiresAuth: true });
  }

  async makeTransfer(
    playerOut: number,
    playerIn: number,
    guard: MutationGuard,
    purchasePrice: number,
    sellingPrice: number
  ): Promise<MutationResult> {
    return this.makeTransfers(
      [{ playerOut, playerIn, purchasePrice, sellingPrice }],
      guard
    );
  }

  async makeTransfers(
    transfers: TransferRequest[],
    guard: MutationGuard
  ): Promise<MutationResult> {
    const permission = getMutationPermission('transfer');
    if (!permission.allowed) return { success: false, outcome: 'rejected', message: permission.reason };
    if (permission.limits.expectedManagerId !== guard.expectedManagerId) {
      return { success: false, outcome: 'rejected', message: 'Mutation guard does not match configured manager' };
    }
    assertNoForeignFileLock(
      process.env.FPL_RUNNER_LOCK_PATH?.trim() || 'data/fpl-runner.lock',
      'FPL runner'
    );
    return withExclusiveFileLock(
      process.env.FPL_MUTATION_LOCK_PATH?.trim() || 'data/fpl-mutation.lock',
      'FPL mutation',
      () => this.runTrackedMutation(
        'transfer',
        guard,
        { transfers, chip: null },
        () => this.makeTransfersUnlocked(transfers, guard)
      )
    );
  }

  private async makeTransfersUnlocked(
    transfers: TransferRequest[],
    guard: MutationGuard
  ): Promise<MutationResult> {
    if (!this.managerId) {
      throw new Error('Manager ID required');
    }

    if (transfers.length === 0) {
      return { success: false, outcome: 'rejected', message: 'At least one transfer is required' };
    }

    let before: MyTeam | null = null;
    try {
      const preflight = await this.validateMutationGuard(guard);
      before = preflight.team;
      validateTransferPayload(before, transfers, preflight.bootstrap.elements);
      const finalPermission = getMutationPermission('transfer');
      if (!finalPermission.allowed) throw new Error(finalPermission.reason);
      if (finalPermission.limits.expectedManagerId !== guard.expectedManagerId) {
        throw new Error('Mutation guard does not match configured manager');
      }
      await this.fetch(`/transfers/`, {
        method: 'POST',
        requiresAuth: true,
        body: {
          confirmed: true,
          entry: this.managerId,
          event: guard.gameweek,
          transfers: transfers.map(transfer => ({
            element_in: transfer.playerIn,
            element_out: transfer.playerOut,
            purchase_price: transfer.purchasePrice,
            selling_price: transfer.sellingPrice,
          })),
          chip: null,
        },
      });
      return await this.reconcileTransferMutation(before, transfers, 'Transfer completed successfully');
    } catch (error) {
      if (before) {
        return this.reconcileTransferMutation(
          before,
          transfers,
          'Transfer was committed despite an interrupted response',
          error
        );
      }
      return { success: false, outcome: 'rejected', message: errorMessage(error, 'Transfer rejected') };
    }
  }

  async updateTeam(
    selection: TeamSelection[],
    guard: MutationGuard,
    chip: 'bboost' | '3xc' | null = null
  ): Promise<MutationResult> {
    const lineupPermission = getMutationPermission('lineup');
    const chipPermission = chip ? getMutationPermission('chip') : null;
    if (!lineupPermission.allowed && !chipPermission?.allowed) {
      return {
        success: false,
        outcome: 'rejected',
        message: chipPermission?.reason ?? lineupPermission.reason,
      };
    }
    const configuredManagerId = (chipPermission?.allowed ? chipPermission.limits : lineupPermission.limits).expectedManagerId;
    if (configuredManagerId !== guard.expectedManagerId) {
      return { success: false, outcome: 'rejected', message: 'Mutation guard does not match configured manager' };
    }
    assertNoForeignFileLock(
      process.env.FPL_RUNNER_LOCK_PATH?.trim() || 'data/fpl-runner.lock',
      'FPL runner'
    );
    return withExclusiveFileLock(
      process.env.FPL_MUTATION_LOCK_PATH?.trim() || 'data/fpl-mutation.lock',
      'FPL mutation',
      () => this.runTrackedMutation(
        'lineup',
        guard,
        { selection, chip },
        () => this.updateTeamUnlocked(selection, guard, chip)
      )
    );
  }

  private async updateTeamUnlocked(
    selection: TeamSelection[],
    guard: MutationGuard,
    chip: 'bboost' | '3xc' | null = null
  ): Promise<MutationResult> {
    if (!this.managerId) throw new Error('Manager ID required');
    if (selection.length !== 15) {
      return { success: false, outcome: 'rejected', message: 'Team selection must contain exactly 15 players' };
    }

    let before: MyTeam | null = null;
    try {
      const preflight = await this.validateMutationGuard(guard);
      before = preflight.team;
      validateTeamSelection(before, selection, preflight.bootstrap.elements);
      validateChipTransition(before, chip, guard.gameweek);
      const lineupChanged = !teamPostcondition(before, selection, null);
      const activeChip = before.chips.find(candidate =>
        candidate.status_for_entry === 'active' || candidate.is_pending === true
      );
      const activatesChip = chip !== null && !activeChip;
      if (!lineupChanged && !activatesChip) throw new Error('Team update does not change lineup or chip state');

      const finalLineupPermission = getMutationPermission('lineup');
      const finalChipPermission = chip ? getMutationPermission('chip') : null;
      if (lineupChanged && !finalLineupPermission.allowed) {
        throw new Error(finalLineupPermission.reason);
      }
      if (activatesChip && !finalChipPermission?.allowed) {
        throw new Error(finalChipPermission?.reason ?? 'Automatic chip mutations are disabled');
      }
      const requiredPermissions = [
        ...(lineupChanged ? [finalLineupPermission] : []),
        ...(activatesChip && finalChipPermission ? [finalChipPermission] : []),
      ];
      if (requiredPermissions.some(permission => permission.limits.expectedManagerId !== guard.expectedManagerId)) {
        throw new Error('Mutation guard does not match configured manager');
      }
      await this.fetch(`/my-team/${this.managerId}/`, {
        method: 'POST',
        requiresAuth: true,
        body: {
          chip,
          picks: selection.map(pick => ({
            element: pick.element,
            position: pick.position,
            is_captain: pick.isCaptain,
            is_vice_captain: pick.isViceCaptain,
          })),
        },
      });
      return await this.reconcileTeamMutation(
        before,
        selection,
        chip,
        chip ? `Team updated with ${chip}` : 'Team updated successfully'
      );
    } catch (error) {
      if (before) {
        return this.reconcileTeamMutation(
          before,
          selection,
          chip,
          chip ? `Team updated with ${chip} despite an interrupted response` : 'Team updated despite an interrupted response',
          error
        );
      }
      return { success: false, outcome: 'rejected', message: errorMessage(error, 'Team update rejected') };
    }
  }

  isMutationQuarantined(): boolean {
    return this.mutationQuarantineReason !== null;
  }

  getMutationQuarantineReason(): string | null {
    return this.mutationQuarantineReason;
  }

  private async validateMutationGuard(guard: MutationGuard): Promise<{ team: MyTeam; bootstrap: BootstrapStatic }> {
    if (this.mutationQuarantineReason) {
      throw new Error(`Mutations quarantined: ${this.mutationQuarantineReason}`);
    }
    if (!this.managerId || this.managerId !== guard.expectedManagerId) {
      throw new Error(`Mutation manager ${this.managerId ?? 'missing'} does not match ${guard.expectedManagerId}`);
    }
    if (!Number.isInteger(guard.gameweek) || guard.gameweek < 1 || guard.gameweek > 38) {
      throw new Error(`Invalid mutation gameweek ${guard.gameweek}`);
    }
    if (!Number.isFinite(guard.safetyMarginMs) || guard.safetyMarginMs < 2 * 60_000) {
      throw new Error('Mutation safety margin must be at least two minutes');
    }

    this.clearCache();
    const bootstrap = await this.getBootstrapStatic();
    const currentSeason = deriveSeasonLabel(bootstrap.events);
    if (guard.season !== currentSeason) {
      throw new Error(`Mutation season ${guard.season} does not match current season ${currentSeason}`);
    }
    const event = bootstrap.events.find(candidate => candidate.id === guard.gameweek);
    if (!event) throw new Error(`GW${guard.gameweek} is not present in current bootstrap data`);
    const currentDeadline = Date.parse(event.deadline_time);
    if (!Number.isFinite(currentDeadline)) throw new Error(`GW${guard.gameweek} has an invalid deadline`);
    const nextEvent = bootstrap.events
      .filter(candidate => candidate.finished !== true && Date.parse(candidate.deadline_time) > Date.now())
      .sort((left, right) => Date.parse(left.deadline_time) - Date.parse(right.deadline_time))[0];
    if (!nextEvent || nextEvent.id !== guard.gameweek) {
      throw new Error(`GW${guard.gameweek} is not the next actionable gameweek`);
    }
    if (currentDeadline !== guard.deadlineAt.getTime()) {
      throw new Error(`GW${guard.gameweek} deadline changed after planning`);
    }
    if (event.can_manage !== true) throw new Error(`GW${guard.gameweek} is not manageable`);
    if (Date.now() + guard.safetyMarginMs >= currentDeadline) {
      throw new Error(`GW${guard.gameweek} is inside the mutation safety margin`);
    }

    const team = await this.getMyTeam();
    if (fingerprintMyTeam(team) !== guard.expectedTeamFingerprint) {
      throw new Error('Authenticated team changed after planning');
    }
    return { team, bootstrap };
  }

  private async reconcileTransferMutation(
    before: MyTeam,
    transfers: TransferRequest[],
    successMessage: string,
    originalError?: unknown
  ): Promise<MutationResult> {
    try {
      const after = await this.getMyTeam();
      if (transferPostcondition(before, after, transfers)) {
        return { success: true, outcome: 'confirmed', message: successMessage };
      }
      const unchanged = fingerprintMyTeam(after) === fingerprintMyTeam(before);
      if (unchanged) {
        return { success: false, outcome: 'rejected', message: errorMessage(originalError, 'Transfer state was unchanged') };
      }
      return this.quarantineMutation('Transfer result does not match the requested final squad');
    } catch (reconciliationError) {
      return this.quarantineMutation(
        `Could not reconcile transfer result: ${errorMessage(reconciliationError, errorMessage(originalError, 'unknown error'))}`
      );
    }
  }

  private async reconcileTeamMutation(
    before: MyTeam,
    selection: TeamSelection[],
    chip: 'bboost' | '3xc' | null,
    successMessage: string,
    originalError?: unknown
  ): Promise<MutationResult> {
    try {
      const after = await this.getMyTeam();
      const activeChipPreserved = chip !== null
        || activeChipFingerprint(after) === activeChipFingerprint(before);
      if (teamPostcondition(after, selection, chip) && activeChipPreserved) {
        return { success: true, outcome: 'confirmed', message: successMessage };
      }
      if (fingerprintMyTeam(after) === fingerprintMyTeam(before)) {
        return { success: false, outcome: 'rejected', message: errorMessage(originalError, 'Team state was unchanged') };
      }
      return this.quarantineMutation(errorMessage(originalError, 'Team update was not reflected by FPL'));
    } catch (reconciliationError) {
      return this.quarantineMutation(
        `Could not reconcile team update: ${errorMessage(reconciliationError, errorMessage(originalError, 'unknown error'))}`
      );
    }
  }

  private quarantineMutation(reason: string): MutationResult {
    this.mutationQuarantineReason = reason;
    return { success: false, outcome: 'unknown', message: `Mutation outcome is unknown; ${reason}` };
  }

  private async runTrackedMutation(
    kind: 'transfer' | 'lineup',
    guard: MutationGuard,
    payload: unknown,
    action: () => Promise<MutationResult>
  ): Promise<MutationResult> {
    const payloadHash = sha256Json(payload);
    const operationKey = sha256Json({
      managerId: guard.expectedManagerId,
      season: guard.season,
      gameweek: guard.gameweek,
      kind,
      payloadHash,
      preStateHash: guard.expectedTeamFingerprint,
    });
    const operation = await beginMutationOperation({
      operationKey,
      managerId: guard.expectedManagerId,
      season: guard.season,
      gameweek: guard.gameweek,
      kind,
      payloadHash,
      preStateHash: guard.expectedTeamFingerprint,
    });
    if (operation.duplicate) {
      const status = operation.record.status;
      if (status === 'confirmed') {
        return {
          success: false,
          outcome: 'rejected',
          message: `Operation ${operation.record.id} was already confirmed; stale request was not replayed`,
        };
      }
      return {
        success: false,
        outcome: status === 'rejected' ? 'rejected' : 'unknown',
        message: `Operation ${operation.record.id} already exists with status ${status}`,
      };
    }

    await updateMutationOperation(operation.record.id, 'in_flight', null);
    try {
      const result = await action();
      await updateMutationOperation(operation.record.id, result.outcome, result.message);
      return result;
    } catch (error) {
      const message = errorMessage(error, 'Mutation threw before it could be reconciled');
      await updateMutationOperation(operation.record.id, 'unknown', message);
      this.mutationQuarantineReason = message;
      throw error;
    }
  }

  // Helper Methods

  getManagerId(): number | undefined {
    return this.managerId;
  }

  setManagerId(id: number): void {
    this.managerId = id;
    if (this.session) {
      this.session.managerId = id;
    }
  }

  clearCache(): void {
    this.bootstrapCache = null;
  }
}

// Singleton instance
let clientInstance: FPLClient | null = null;

export interface FPLClientOptions {
  cookie?: string;
  bearerToken?: string;
  managerId?: number;
  expectedManagerId?: number;
}

export function getFPLClient(options: FPLClientOptions = {}): FPLClient {
  if (!clientInstance) {
    clientInstance = new FPLClient(
      options.cookie,
      options.bearerToken,
      options.managerId,
      options.expectedManagerId
    );
  }
  return clientInstance;
}

export function getFPLClientFromEnv(): FPLClient {
  const managerId = process.env.FPL_MANAGER_ID ? parseInt(process.env.FPL_MANAGER_ID) : undefined;
  const expectedManagerId = process.env.FPL_EXPECTED_MANAGER_ID
    ? parseInt(process.env.FPL_EXPECTED_MANAGER_ID)
    : managerId;
  return getFPLClient({
    cookie: process.env.FPL_COOKIE ?? process.env.FPL_SESSION_COOKIE,
    bearerToken: process.env.FPL_BEARER_TOKEN,
    managerId: expectedManagerId ?? managerId,
    expectedManagerId,
  });
}

export function resetFPLClient(): void {
  clientInstance = null;
}

export { FPLClient };

export function fingerprintMyTeam(team: MyTeam): string {
  const payload = {
    picks: [...team.picks]
      .map(pick => ({
        element: pick.element,
        position: pick.position,
        captain: pick.is_captain,
        viceCaptain: pick.is_vice_captain,
        purchasePrice: pick.purchase_price ?? null,
        sellingPrice: pick.selling_price ?? null,
      }))
      .sort((left, right) => left.element - right.element),
    transfers: {
      bank: team.transfers.bank,
      made: team.transfers.made,
      limit: team.transfers.limit,
      status: team.transfers.status,
    },
    chips: [...team.chips]
      .map(chip => ({ name: chip.name, number: chip.number, status: chip.status_for_entry, pending: chip.is_pending ?? false }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.number - right.number),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validateTransferPayload(team: MyTeam, transfers: TransferRequest[], players: Player[]): void {
  const currentIds = new Set(team.picks.map(pick => pick.element));
  const playersById = new Map(players.map(player => [player.id, player]));
  const outgoing = new Set<number>();
  const incoming = new Set<number>();
  let bank = team.transfers.bank;
  for (const transfer of transfers) {
    if (!currentIds.has(transfer.playerOut)) throw new Error(`Outgoing player ${transfer.playerOut} is not in the current squad`);
    if (currentIds.has(transfer.playerIn)) throw new Error(`Incoming player ${transfer.playerIn} is already in the current squad`);
    if (outgoing.has(transfer.playerOut) || incoming.has(transfer.playerIn)) throw new Error('Transfer payload contains duplicate players');
    const pick = team.picks.find(candidate => candidate.element === transfer.playerOut)!;
    const outgoingPlayer = playersById.get(transfer.playerOut);
    const incomingPlayer = playersById.get(transfer.playerIn);
    if (!outgoingPlayer || !incomingPlayer) throw new Error('Transfer payload references an unknown player');
    if (outgoingPlayer.element_type !== incomingPlayer.element_type) throw new Error('Transfer changes player position');
    if (incomingPlayer.can_select === false || incomingPlayer.can_transact === false || incomingPlayer.removed === true) {
      throw new Error(`Incoming player ${transfer.playerIn} is not selectable`);
    }
    if (pick.selling_price === undefined) throw new Error(`Selling price is unavailable for player ${transfer.playerOut}`);
    if (pick.selling_price !== transfer.sellingPrice) throw new Error(`Selling price changed for player ${transfer.playerOut}`);
    if (incomingPlayer.now_cost !== transfer.purchasePrice) throw new Error(`Purchase price changed for player ${transfer.playerIn}`);
    bank += transfer.sellingPrice - transfer.purchasePrice;
    outgoing.add(transfer.playerOut);
    incoming.add(transfer.playerIn);
  }
  if (bank < 0) throw new Error('Transfer payload exceeds the current bank');

  const finalIds = new Set(currentIds);
  for (const transfer of transfers) {
    finalIds.delete(transfer.playerOut);
    finalIds.add(transfer.playerIn);
  }
  if (finalIds.size !== 15) throw new Error('Transfer payload does not produce 15 unique players');
  const finalPlayers = [...finalIds].map(playerId => playersById.get(playerId));
  if (finalPlayers.some(player => !player)) throw new Error('Final squad contains an unknown player');
  const positionCounts = new Map<number, number>();
  const clubCounts = new Map<number, number>();
  for (const player of finalPlayers as Player[]) {
    positionCounts.set(player.element_type, (positionCounts.get(player.element_type) ?? 0) + 1);
    clubCounts.set(player.team, (clubCounts.get(player.team) ?? 0) + 1);
  }
  const expectedPositions = new Map([[1, 2], [2, 5], [3, 5], [4, 3]]);
  for (const [position, expected] of expectedPositions) {
    if (positionCounts.get(position) !== expected) throw new Error(`Final squad has invalid element type ${position}`);
  }
  if ([...clubCounts.values()].some(count => count > 3)) throw new Error('Final squad exceeds the three-player club limit');
}

function validateTeamSelection(team: MyTeam, selection: TeamSelection[], players: Player[]): void {
  const currentIds = [...team.picks].map(pick => pick.element).sort((a, b) => a - b);
  const selectedIds = selection.map(pick => pick.element).sort((a, b) => a - b);
  if (new Set(selectedIds).size !== 15 || selectedIds.some((id, index) => id !== currentIds[index])) {
    throw new Error('Team selection does not match the current 15-player squad');
  }
  const positions = selection.map(pick => pick.position).sort((a, b) => a - b);
  if (positions.some((position, index) => position !== index + 1)) throw new Error('Team selection positions must be exactly 1-15');
  const captains = selection.filter(pick => pick.isCaptain);
  const viceCaptains = selection.filter(pick => pick.isViceCaptain);
  if (captains.length !== 1 || viceCaptains.length !== 1 || captains[0]!.element === viceCaptains[0]!.element) {
    throw new Error('Team selection must have one distinct captain and vice-captain');
  }
  if (captains[0]!.position > 11 || viceCaptains[0]!.position > 11) {
    throw new Error('Captain and vice-captain must be in the starting XI');
  }
  const playersById = new Map(players.map(player => [player.id, player]));
  const starterTypes = selection
    .filter(pick => pick.position <= 11)
    .map(pick => playersById.get(pick.element)?.element_type);
  if (starterTypes.some(value => value === undefined)) throw new Error('Team selection contains an unknown player');
  const counts = new Map<number, number>();
  for (const elementType of starterTypes as number[]) counts.set(elementType, (counts.get(elementType) ?? 0) + 1);
  if (counts.get(1) !== 1
    || (counts.get(2) ?? 0) < 3 || (counts.get(2) ?? 0) > 5
    || (counts.get(3) ?? 0) < 2 || (counts.get(3) ?? 0) > 5
    || (counts.get(4) ?? 0) < 1 || (counts.get(4) ?? 0) > 3) {
    throw new Error('Team selection has an illegal formation');
  }
  const benchGoalkeeper = selection.find(pick => pick.position === 12);
  if (!benchGoalkeeper || playersById.get(benchGoalkeeper.element)?.element_type !== 1) {
    throw new Error('Bench position 12 must contain the substitute goalkeeper');
  }
}

function transferPostcondition(before: MyTeam, after: MyTeam, transfers: TransferRequest[]): boolean {
  const expected = new Set(before.picks.map(pick => pick.element));
  for (const transfer of transfers) {
    expected.delete(transfer.playerOut);
    expected.add(transfer.playerIn);
  }
  const actual = new Set(after.picks.map(pick => pick.element));
  const squadMatches = expected.size === actual.size
    && [...expected].every(playerId => actual.has(playerId));
  const expectedBank = before.transfers.bank + transfers.reduce(
    (bank, transfer) => bank + transfer.sellingPrice - transfer.purchasePrice,
    0
  );
  const expectedMade = before.transfers.made + transfers.length;
  const expectedCost = before.transfers.status === 'unlimited'
    ? 0
    : Math.max(0, expectedMade - (before.transfers.limit ?? 0)) * 4;
  return squadMatches
    && after.transfers.bank === expectedBank
    && after.transfers.made === expectedMade
    && after.transfers.cost === expectedCost
    && activeChipFingerprint(after) === activeChipFingerprint(before);
}

function activeChipFingerprint(team: MyTeam): string {
  return team.chips
    .filter(candidate => candidate.status_for_entry === 'active' || candidate.is_pending === true)
    .map(candidate => `${candidate.name}:${candidate.number}`)
    .sort()
    .join(',');
}

function teamPostcondition(team: MyTeam, selection: TeamSelection[], chip: 'bboost' | '3xc' | null): boolean {
  const expected = new Map(selection.map(pick => [pick.element, pick]));
  const picksMatch = team.picks.every(pick => {
    const value = expected.get(pick.element);
    return value !== undefined
      && value.position === pick.position
      && value.isCaptain === pick.is_captain
      && value.isViceCaptain === pick.is_vice_captain;
  });
  if (!picksMatch) return false;
  if (!chip) return true;
  return team.chips.some(candidate =>
    candidate.name === chip && (candidate.status_for_entry === 'active' || candidate.is_pending === true)
  );
}

function validateChipTransition(team: MyTeam, chip: 'bboost' | '3xc' | null, gameweek: number): void {
  const active = team.chips.find(candidate => candidate.status_for_entry === 'active' || candidate.is_pending === true);
  // Wildcard and Free Hit are transfer chips. They are already irreversible
  // once active and are not valid values for the lineup endpoint; a null team
  // update preserves them rather than trying to reactivate or cancel them.
  if (active && (active.name === 'wildcard' || active.name === 'freehit') && chip === null) return;
  if (active && chip !== active.name) {
    throw new Error(`Active chip ${active.name} must be preserved by the team update`);
  }
  if (!chip || active) return;
  const available = team.chips.some(candidate =>
    candidate.name === chip
    && candidate.status_for_entry === 'available'
    && gameweek >= candidate.start_event
    && gameweek <= candidate.stop_event
  );
  if (!available) throw new Error(`Chip ${chip} is not available in GW${gameweek}`);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function sha256Json(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
