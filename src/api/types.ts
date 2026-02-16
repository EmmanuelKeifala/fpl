// FPL API Type Definitions

// Bootstrap Static Types
export interface BootstrapStatic {
  events: Gameweek[];
  game_settings: GameSettings;
  phases: Phase[];
  teams: Team[];
  elements: Player[];
  element_stats: ElementStat[];
  element_types: ElementType[];
}

export interface Gameweek {
  id: number;
  name: string;
  deadline_time: string;
  average_entry_score: number;
  finished: boolean;
  data_checked: boolean;
  highest_scoring_entry: number;
  deadline_time_epoch: number;
  deadline_time_game_offset: number;
  highest_score: number;
  is_previous: boolean;
  is_current: boolean;
  is_next: boolean;
  cup_leagues_created: boolean;
  h2h_ko_matches_created: boolean;
  chip_plays: ChipPlay[];
  most_selected: number;
  most_transferred_in: number;
  top_element: number;
  top_element_info: TopElementInfo;
  transfers_made: number;
  most_captained: number;
  most_vice_captained: number;
}

export interface ChipPlay {
  chip_name: string;
  num_played: number;
}

export interface TopElementInfo {
  id: number;
  points: number;
}

export interface GameSettings {
  league_join_private_max: number;
  league_join_public_max: number;
  league_max_size_public_classic: number;
  league_max_size_public_h2h: number;
  league_max_size_private_h2h: number;
  league_max_ko_rounds_private_h2h: number;
  league_prefix_public: string;
  league_points_h2h_win: number;
  league_points_h2h_lose: number;
  league_points_h2h_draw: number;
  squad_squadplay: number;
  squad_squadsize: number;
  squad_team_limit: number;
  squad_total_spend: number;
  ui_currency_multiplier: number;
  ui_use_special_shirts: boolean;
  ui_special_shirt_exclusions: number[];
  stats_form_days: number;
  sys_vice_captain_enabled: boolean;
  transfers_cap: number;  // Max banked transfers (now 5)
  transfers_sell_on_fee: number;
  max_extra_free_transfers: number;
  league_h2h_tiebreak_stats: string[];
  timezone: string;
}

export interface Phase {
  id: number;
  name: string;
  start_event: number;
  stop_event: number;
  highest_score: number | null;
}

export interface Team {
  code: number;
  draw: number;
  form: null;
  id: number;
  loss: number;
  name: string;
  played: number;
  points: number;
  position: number;
  short_name: string;
  strength: number;
  team_division: null;
  unavailable: boolean;
  win: number;
  strength_overall_home: number;
  strength_overall_away: number;
  strength_attack_home: number;
  strength_attack_away: number;
  strength_defence_home: number;
  strength_defence_away: number;
  pulse_id: number;
}

export interface Player {
  chance_of_playing_next_round: number | null;
  chance_of_playing_this_round: number | null;
  code: number;
  cost_change_event: number;
  cost_change_event_fall: number;
  cost_change_start: number;
  cost_change_start_fall: number;
  dreamteam_count: number;
  element_type: number;  // 1=GK, 2=DEF, 3=MID, 4=FWD
  ep_next: string;
  ep_this: string;
  event_points: number;
  first_name: string;
  form: string;
  id: number;
  in_dreamteam: boolean;
  news: string;
  news_added: string | null;
  now_cost: number;  // Price in 0.1m units (e.g., 100 = £10.0m)
  photo: string;
  points_per_game: string;
  second_name: string;
  selected_by_percent: string;
  special: boolean;
  squad_number: null;
  status: string;  // 'a' = available, 'i' = injured, etc.
  team: number;
  team_code: number;
  total_points: number;
  transfers_in: number;
  transfers_in_event: number;
  transfers_out: number;
  transfers_out_event: number;
  value_form: string;
  value_season: string;
  web_name: string;
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  bonus: number;
  bps: number;
  influence: string;
  creativity: string;
  threat: string;
  ict_index: string;
  starts: number;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;
  influence_rank: number;
  influence_rank_type: number;
  creativity_rank: number;
  creativity_rank_type: number;
  threat_rank: number;
  threat_rank_type: number;
  ict_index_rank: number;
  ict_index_rank_type: number;
  corners_and_indirect_freekicks_order: number | null;
  corners_and_indirect_freekicks_text: string;
  direct_freekicks_order: number | null;
  direct_freekicks_text: string;
  penalties_order: number | null;
  penalties_text: string;
  expected_goals_per_90: number;
  saves_per_90: number;
  expected_assists_per_90: number;
  expected_goal_involvements_per_90: number;
  expected_goals_conceded_per_90: number;
  goals_conceded_per_90: number;
  now_cost_rank: number;
  now_cost_rank_type: number;
  form_rank: number;
  form_rank_type: number;
  points_per_game_rank: number;
  points_per_game_rank_type: number;
  selected_rank: number;
  selected_rank_type: number;
  starts_per_90: number;
  clean_sheets_per_90: number;
}

export interface ElementStat {
  label: string;
  name: string;
}

export interface ElementType {
  id: number;
  plural_name: string;
  plural_name_short: string;
  singular_name: string;
  singular_name_short: string;
  squad_select: number;
  squad_min_select: number | null;
  squad_max_select: number | null;
  squad_min_play: number;
  squad_max_play: number;
  ui_shirt_specific: boolean;
  sub_positions_locked: number[];
  element_count: number;
}

// Fixture Types
export interface Fixture {
  code: number;
  event: number | null;  // null for unscheduled
  finished: boolean;
  finished_provisional: boolean;
  id: number;
  kickoff_time: string | null;
  minutes: number;
  provisional_start_time: boolean;
  started: boolean;
  team_a: number;
  team_a_score: number | null;
  team_h: number;
  team_h_score: number | null;
  stats: FixtureStat[];
  team_h_difficulty: number;  // FDR 1-5
  team_a_difficulty: number;  // FDR 1-5
  pulse_id: number;
}

export interface FixtureStat {
  identifier: string;
  a: { value: number; element: number }[];
  h: { value: number; element: number }[];
}

// Manager Entry Types
export interface ManagerEntry {
  id: number;
  joined_time: string;
  started_event: number;
  favourite_team: number;
  player_first_name: string;
  player_last_name: string;
  player_region_id: number;
  player_region_name: string;
  player_region_iso_code_short: string;
  player_region_iso_code_long: string;
  years_active: number;
  summary_overall_points: number;
  summary_overall_rank: number;
  summary_event_points: number;
  summary_event_rank: number;
  current_event: number;
  leagues: ManagerLeagues;
  name: string;
  name_change_blocked: boolean;
  entered_events: number[];
  kit: string | null;
  last_deadline_bank: number;
  last_deadline_value: number;
  last_deadline_total_transfers: number;
}

export interface ManagerLeagues {
  classic: LeagueInfo[];
  h2h: LeagueInfo[];
  cup: CupInfo;
  cup_matches: any[];
}

export interface LeagueInfo {
  id: number;
  name: string;
  short_name: string | null;
  created: string;
  closed: boolean;
  rank: number | null;
  max_entries: number | null;
  league_type: string;
  scoring: string;
  admin_entry: number | null;
  start_event: number;
  entry_can_leave: boolean;
  entry_can_admin: boolean;
  entry_can_invite: boolean;
  has_cup: boolean;
  cup_league: number | null;
  cup_qualified: boolean | null;
  rank_count: number | null;
  entry_percentile_rank: number | null;
  active_phases: { phase: number; rank: number; last_rank: number; rank_sort: number; total: number; league_id: number; rank_count: number | null; entry_percentile_rank: number | null }[];
  entry_rank: number;
  entry_last_rank: number;
}

export interface CupInfo {
  matches: any[];
  status: { qualification_event: number | null; qualification_numbers: number | null; qualification_rank: number | null; qualification_state: string | null };
  cup_league: number | null;
}

// Manager History
export interface ManagerHistory {
  current: GameweekHistory[];
  past: PastSeason[];
  chips: ChipUsage[];
}

export interface GameweekHistory {
  event: number;
  points: number;
  total_points: number;
  rank: number;
  rank_sort: number;
  overall_rank: number;
  percentile_rank: number;
  bank: number;
  value: number;
  event_transfers: number;
  event_transfers_cost: number;
  points_on_bench: number;
}

export interface PastSeason {
  season_name: string;
  total_points: number;
  rank: number;
}

export interface ChipUsage {
  name: string;
  time: string;
  event: number;
}

// Manager Picks (Team for a gameweek)
export interface ManagerPicks {
  active_chip: string | null;
  automatic_subs: AutomaticSub[];
  entry_history: GameweekHistory;
  picks: Pick[];
}

export interface AutomaticSub {
  entry: number;
  element_in: number;
  element_out: number;
  event: number;
}

export interface Pick {
  element: number;
  position: number;  // 1-15, 12-15 are bench
  multiplier: number;  // 0=benched, 1=playing, 2=captain, 3=triple captain
  is_captain: boolean;
  is_vice_captain: boolean;
}

// My Team (Authenticated)
export interface MyTeam {
  picks: Pick[];
  chips: AvailableChip[];
  transfers: TransferInfo;
}

export interface AvailableChip {
  status_for_entry: 'available' | 'played' | 'unavailable';
  played_by_entry: number[];
  name: string;
  number: number;
  start_event: number;
  stop_event: number;
  chip_type: string;
}

export interface TransferInfo {
  cost: number;
  status: string;
  limit: number;
  made: number;
  bank: number;
  value: number;
}

// Transfer Types
export interface Transfer {
  element_in: number;
  element_in_cost: number;
  element_out: number;
  element_out_cost: number;
  entry: number;
  event: number;
  time: string;
}

// Live Gameweek Data
export interface LiveGameweek {
  elements: LiveElement[];
}

export interface LiveElement {
  id: number;
  stats: LiveStats;
  explain: ExplainStat[];
}

export interface LiveStats {
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  goals_conceded: number;
  own_goals: number;
  penalties_saved: number;
  penalties_missed: number;
  yellow_cards: number;
  red_cards: number;
  saves: number;
  bonus: number;
  bps: number;
  influence: string;
  creativity: string;
  threat: string;
  ict_index: string;
  starts: number;
  expected_goals: string;
  expected_assists: string;
  expected_goal_involvements: string;
  expected_goals_conceded: string;
  total_points: number;
  in_dreamteam: boolean;
}

export interface ExplainStat {
  fixture: number;
  stats: { identifier: string; points: number; value: number }[];
}

// League Standings
export interface ClassicLeagueStandings {
  new_entries: { has_next: boolean; page: number; results: any[] };
  last_updated_data: string;
  league: { id: number; name: string; created: string; closed: boolean; max_entries: number | null; league_type: string; scoring: string; admin_entry: number | null; start_event: number; code_privacy: string; has_cup: boolean; cup_league: number | null; rank: number | null };
  standings: { has_next: boolean; page: number; results: LeagueStanding[] };
}

export interface LeagueStanding {
  id: number;
  event_total: number;
  player_name: string;
  rank: number;
  last_rank: number;
  rank_sort: number;
  total: number;
  entry: number;
  entry_name: string;
}

// Session/Auth Types
export interface FPLSession {
  cookies: string;
  csrfToken: string;
  managerId: number;
}
