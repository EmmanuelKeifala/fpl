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
} from './types.js';

const FPL_BASE_URL = 'https://fantasy.premierleague.com/api';
const FPL_LOGIN_URL = 'https://users.premierleague.com/accounts/login/';

interface FetchOptions {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  requiresAuth?: boolean;
}

class FPLClient {
  private session: FPLSession | null = null;
  private bootstrapCache: { data: BootstrapStatic; timestamp: number } | null = null;
  private readonly CACHE_TTL = 60 * 60 * 1000; // 1 hour

  constructor(
    private email?: string,
    private password?: string,
    private managerId?: number
  ) {}

  // Authentication
  async login(): Promise<boolean> {
    if (!this.email || !this.password) {
      throw new Error('Email and password required for authentication');
    }

    try {
      // Step 1: Get initial cookies and CSRF token
      const loginPageRes = await fetch(FPL_LOGIN_URL, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      // Properly collect ALL set-cookie headers (Node.js fetch quirk)
      const initialCookies = loginPageRes.headers.getSetCookie?.() || [];
      const initialCookieStr = initialCookies.join('; ');
      const csrfMatch = initialCookieStr.match(/csrftoken=([^;]+)/);
      const csrfToken = csrfMatch ? csrfMatch[1] : '';

      // Build cookie header from individual cookie key=value pairs
      const parseCookiePairs = (cookieHeaders: string[]): string => {
        return cookieHeaders
          .map(c => c.split(';')[0].trim()) // Extract just the key=value part
          .filter(Boolean)
          .join('; ');
      };

      const initialCookieHeader = parseCookiePairs(initialCookies);

      // Step 2: Submit login form
      const formData = new URLSearchParams({
        login: this.email,
        password: this.password,
        app: 'plfpl-web',
        redirect_uri: 'https://fantasy.premierleague.com/',
      });

      const loginRes = await fetch(FPL_LOGIN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Cookie: initialCookieHeader,
          Referer: FPL_LOGIN_URL,
          'X-CSRFToken': csrfToken,
        },
        body: formData.toString(),
        redirect: 'manual',
      });

      // Collect ALL session cookies from login response
      const loginCookies = loginRes.headers.getSetCookie?.() || [];
      const allCookieHeaders = [...initialCookies, ...loginCookies];
      const sessionCookieHeader = parseCookiePairs(allCookieHeaders);
      const fullCookieStr = allCookieHeaders.join('; ');
      
      if (loginRes.status === 302 || fullCookieStr.includes('pl_profile')) {
        this.session = {
          cookies: sessionCookieHeader,
          csrfToken,
          managerId: this.managerId || 0,
        };

        // Get manager ID if not provided
        if (!this.managerId) {
          const me = await this.getMe();
          if (me) {
            this.session.managerId = me.player.entry;
            this.managerId = me.player.entry;
          }
        }

        return true;
      }

      return false;
    } catch (error) {
      console.error('Login failed:', error);
      return false;
    }
  }

  isAuthenticated(): boolean {
    return this.session !== null;
  }

  private async fetch<T>(endpoint: string, options: FetchOptions = {}): Promise<T> {
    const url = endpoint.startsWith('http') ? endpoint : `${FPL_BASE_URL}${endpoint}`;
    
    const headers: Record<string, string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    };

    if (options.requiresAuth) {
      if (!this.session) {
        throw new Error('Authentication required. Call login() first.');
      }
      headers.Cookie = this.session.cookies;
      headers['X-CSRFToken'] = this.session.csrfToken;
    }

    if (options.method === 'POST' && options.body) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    if (!response.ok) {
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

  async getMe(): Promise<{ player: { entry: number } } | null> {
    try {
      return await this.fetch<{ player: { entry: number } }>('/me/', { requiresAuth: true });
    } catch {
      return null;
    }
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
    if (!this.managerId) {
      throw new Error('Manager ID required');
    }

    try {
      await this.fetch(`/transfers/`, {
        method: 'POST',
        requiresAuth: true,
        body: {
          confirmed: true,
          entry: this.managerId,
          event: gameweek,
          transfers: [
            {
              element_in: playerIn,
              element_out: playerOut,
              purchase_price: purchasePrice,
              selling_price: sellingPrice,
            },
          ],
          wildcard: false,
          freehit: false,
        },
      });
      return { success: true, message: 'Transfer completed successfully' };
    } catch (error) {
      return { success: false, message: error instanceof Error ? error.message : 'Transfer failed' };
    }
  }

  async playChip(
    chipName: 'wildcard' | 'freehit' | 'bboost' | '3xc',
    gameweek: number
  ): Promise<{ success: boolean; message: string }> {
    if (!this.managerId) {
      throw new Error('Manager ID required');
    }

    return {
      success: false,
      message: `Automatic ${chipName} activation for GW${gameweek} is not implemented safely. Activate the chip manually on the FPL website.`,
    };
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

export function getFPLClient(email?: string, password?: string, managerId?: number): FPLClient {
  if (!clientInstance) {
    clientInstance = new FPLClient(email, password, managerId);
  }
  return clientInstance;
}

export function resetFPLClient(): void {
  clientInstance = null;
}

export { FPLClient };
