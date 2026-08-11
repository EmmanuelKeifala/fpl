// FPL API Client with Authentication
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
  Pick,
} from './types.js';
import { getValidTokens } from './auth.js';

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

class FPLClient {
  private session: FPLSession | null = null;
  private bootstrapCache: { data: BootstrapStatic; timestamp: number } | null = null;
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour
  private lastAuthFailure: { at: Date; message: string } | null = null;

  constructor(
    private cookie?: string,
    private bearerToken?: string,
    private managerId?: number
  ) {}

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

    if (this.managerId && this.managerId !== me.player.entry) {
      console.warn(
        `[AUTH] FPL_MANAGER_ID ${this.managerId} is stale; using authenticated current-season entry ${me.player.entry}.`
      );
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

    return response.json() as Promise<T>;
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
    gameweek: number,
    purchasePrice: number,
    sellingPrice: number
  ): Promise<{ success: boolean; message: string }> {
    return this.makeTransfers(
      [{ playerOut, playerIn, purchasePrice, sellingPrice }],
      gameweek
    );
  }

  async makeTransfers(
    transfers: TransferRequest[],
    gameweek: number,
    chip?: 'wildcard' | 'freehit'
  ): Promise<{ success: boolean; message: string }> {
    if (!this.managerId) {
      throw new Error('Manager ID required');
    }

    if (transfers.length === 0) {
      return { success: false, message: 'At least one transfer is required' };
    }

    try {
      await this.fetch(`/transfers/`, {
        method: 'POST',
        requiresAuth: true,
        body: {
          confirmed: true,
          entry: this.managerId,
          event: gameweek,
          transfers: transfers.map(transfer => ({
            element_in: transfer.playerIn,
            element_out: transfer.playerOut,
            purchase_price: transfer.purchasePrice,
            selling_price: transfer.sellingPrice,
          })),
          wildcard: chip === 'wildcard',
          freehit: chip === 'freehit',
        },
      });
      return { success: true, message: 'Transfer completed successfully' };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Transfer failed' };
    }
  }

  async updateTeam(
    selection: TeamSelection[],
    chip: 'bboost' | '3xc' | null = null
  ): Promise<{ success: boolean; message: string }> {
    if (!this.managerId) throw new Error('Manager ID required');
    if (selection.length !== 15) {
      return { success: false, message: 'Team selection must contain exactly 15 players' };
    }

    try {
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
      return { success: true, message: chip ? `Team updated with ${chip}` : 'Team updated successfully' };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Team update failed' };
    }
  }

  async playChip(
    chipName: 'wildcard' | 'freehit' | 'bboost' | '3xc',
    gameweek: number,
    picks?: Pick[]
  ): Promise<{ success: boolean; message: string }> {
    if (!this.managerId) {
      throw new Error('Manager ID required');
    }

    if ((chipName === 'bboost' || chipName === '3xc') && picks) {
      return this.updateTeam(
        picks.map(pick => ({
          element: pick.element,
          position: pick.position,
          isCaptain: pick.is_captain,
          isViceCaptain: pick.is_vice_captain,
        })),
        chipName
      );
    }

    return { success: false, message: `${chipName} requires a complete transfer plan for GW${gameweek}` };
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
}

export function getFPLClient(options: FPLClientOptions = {}): FPLClient {
  if (!clientInstance) {
    clientInstance = new FPLClient(options.cookie, options.bearerToken, options.managerId);
  }
  return clientInstance;
}

export function getFPLClientFromEnv(): FPLClient {
  return getFPLClient({
    cookie: process.env.FPL_COOKIE ?? process.env.FPL_SESSION_COOKIE,
    bearerToken: process.env.FPL_BEARER_TOKEN,
    managerId: process.env.FPL_MANAGER_ID ? parseInt(process.env.FPL_MANAGER_ID) : undefined,
  });
}

export function resetFPLClient(): void {
  clientInstance = null;
}

export { FPLClient };
