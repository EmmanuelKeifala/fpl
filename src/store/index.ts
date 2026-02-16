// Zustand Store for FPL Agent State Management
import { createStore } from 'zustand/vanilla';
import type { Player, Team, Gameweek, Fixture, ManagerEntry, MyTeam } from '../api/types.js';

// Store Types
export interface FPLState {
  // Auth state
  isAuthenticated: boolean;
  managerId: number | null;
  
  // Cached data
  players: Map<number, Player>;
  teams: Map<number, Team>;
  fixtures: Fixture[];
  gameweeks: Gameweek[];
  currentGameweek: number;
  
  // User data
  myTeam: MyTeam | null;
  managerEntry: ManagerEntry | null;
  
  // Cache timestamps
  bootstrapLastFetched: number | null;
  myTeamLastFetched: number | null;
  
  // Loading states
  isLoading: boolean;
  error: string | null;
}

export interface FPLActions {
  // Auth
  setAuthenticated: (isAuthenticated: boolean, managerId?: number) => void;
  
  // Data setters
  setBootstrapData: (players: Player[], teams: Team[], gameweeks: Gameweek[]) => void;
  setFixtures: (fixtures: Fixture[]) => void;
  setMyTeam: (myTeam: MyTeam) => void;
  setManagerEntry: (entry: ManagerEntry) => void;
  setCurrentGameweek: (gw: number) => void;
  
  // Getters
  getPlayer: (id: number) => Player | undefined;
  getTeam: (id: number) => Team | undefined;
  getPlayersByTeam: (teamId: number) => Player[];
  getMySquadPlayerIds: () => number[];
  getMySquadByTeam: () => Map<number, number[]>;
  
  // Cache validation
  isBootstrapStale: () => boolean;
  isMyTeamStale: () => boolean;
  
  // State management
  setLoading: (isLoading: boolean) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export type FPLStore = FPLState & FPLActions;

// Cache TTL in milliseconds
const BOOTSTRAP_TTL = 60 * 60 * 1000; // 1 hour
const MY_TEAM_TTL = 5 * 60 * 1000; // 5 minutes

// Initial state
const initialState: FPLState = {
  isAuthenticated: false,
  managerId: null,
  players: new Map(),
  teams: new Map(),
  fixtures: [],
  gameweeks: [],
  currentGameweek: 1,
  myTeam: null,
  managerEntry: null,
  bootstrapLastFetched: null,
  myTeamLastFetched: null,
  isLoading: false,
  error: null,
};

// Create the store
export const fplStore = createStore<FPLStore>((set, get) => ({
  ...initialState,
  
  // Auth actions
  setAuthenticated: (isAuthenticated, managerId) => {
    set({ isAuthenticated, managerId: managerId ?? get().managerId });
  },
  
  // Data setters
  setBootstrapData: (players, teams, gameweeks) => {
    const playersMap = new Map<number, Player>();
    players.forEach(p => playersMap.set(p.id, p));
    
    const teamsMap = new Map<number, Team>();
    teams.forEach(t => teamsMap.set(t.id, t));
    
    const currentGW = gameweeks.find(gw => gw.is_current)?.id || 1;
    
    set({
      players: playersMap,
      teams: teamsMap,
      gameweeks,
      currentGameweek: currentGW,
      bootstrapLastFetched: Date.now(),
    });
  },
  
  setFixtures: (fixtures) => {
    set({ fixtures });
  },
  
  setMyTeam: (myTeam) => {
    set({ myTeam, myTeamLastFetched: Date.now() });
  },
  
  setManagerEntry: (entry) => {
    set({ managerEntry: entry });
  },
  
  setCurrentGameweek: (gw) => {
    set({ currentGameweek: gw });
  },
  
  // Getters
  getPlayer: (id) => {
    return get().players.get(id);
  },
  
  getTeam: (id) => {
    return get().teams.get(id);
  },
  
  getPlayersByTeam: (teamId) => {
    const players: Player[] = [];
    get().players.forEach(p => {
      if (p.team === teamId) players.push(p);
    });
    return players;
  },
  
  getMySquadPlayerIds: () => {
    const myTeam = get().myTeam;
    if (!myTeam) return [];
    return myTeam.picks.map(p => p.element);
  },
  
  getMySquadByTeam: () => {
    const myTeam = get().myTeam;
    const players = get().players;
    const squadByTeam = new Map<number, number[]>();
    
    if (!myTeam) return squadByTeam;
    
    myTeam.picks.forEach(pick => {
      const player = players.get(pick.element);
      if (player) {
        const teamPlayers = squadByTeam.get(player.team) || [];
        teamPlayers.push(pick.element);
        squadByTeam.set(player.team, teamPlayers);
      }
    });
    
    return squadByTeam;
  },
  
  // Cache validation
  isBootstrapStale: () => {
    const lastFetched = get().bootstrapLastFetched;
    if (!lastFetched) return true;
    return Date.now() - lastFetched > BOOTSTRAP_TTL;
  },
  
  isMyTeamStale: () => {
    const lastFetched = get().myTeamLastFetched;
    if (!lastFetched) return true;
    return Date.now() - lastFetched > MY_TEAM_TTL;
  },
  
  // State management
  setLoading: (isLoading) => {
    set({ isLoading });
  },
  
  setError: (error) => {
    set({ error });
  },
  
  reset: () => {
    set(initialState);
  },
}));

// Helper to get current state
export const getState = () => fplStore.getState();

// Helper to subscribe to changes
export const subscribe = fplStore.subscribe;

// Export store type for use in other files
export type { FPLStore as Store };
