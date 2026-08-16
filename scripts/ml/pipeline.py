#!/usr/bin/env python3
"""Build and train a leakage-safe, identity-independent FPL fixture model."""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


MODEL_VERSION = "player-fixture-v1"
DATA_VERSION = "historical-gw-raw-v1"
SCHEMA_VERSION = "player-fixture-features-v1"
SEASONS = ("2022-2023", "2023-2024", "2024-2025", "2025-2026")
TRAIN_SEASONS = SEASONS[:2]
VALIDATION_SEASON = SEASONS[-2]
TEST_SEASON = SEASONS[-1]
POSITIONS = ("GK", "DEF", "MID", "FWD")
WINDOWS = (2, 4, 6)
TEAM_WINDOWS = (4, 6)
SEED = 42
SELF_CHECK_TOLERANCE = 1e-10

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_HISTORICAL_DIR = REPO_ROOT / "data" / "historical"
DEFAULT_DATASET_DIR = REPO_ROOT / "data" / "ml" / MODEL_VERSION
DEFAULT_MODEL_DIR = REPO_ROOT / "artifacts" / "ml" / MODEL_VERSION

METADATA_FIELDS = (
    "season",
    "target_gameweek",
    "fixture_id",
    "player_id",
    "player_name",
    "position",
    "team_id",
    "team_name",
    "opponent_id",
    "kickoff_time",
)
TARGET_FIELDS = (
    "target_appearance",
    "target_start",
    "target_minutes",
    "target_total_points",
)
IDENTITY_FIELDS_EXCLUDED = (
    "element",
    "name",
    "team",
    "team_id",
    "opponent_team",
    "fixture",
    "fixture_id",
    "player_id",
    "player_name",
    "team_name",
    "opponent_id",
    "kickoff_time",
)

CONTEXT_FEATURES = (
    "is_home",
    "gameweek_phase",
    "club_gw_match_count",
    "known_price_m",
    "price_cold_start",
    "club_rest_days",
    "club_rest_missing",
    "opposition_rest_days",
    "opposition_rest_missing",
    "scoring_defensive_contributions",
    "position_gk",
    "position_def",
    "position_mid",
    "position_fwd",
)
TEAM_FEATURES = tuple(
    feature
    for side in ("club", "opposition")
    for feature in (
        f"{side}_matches_std",
        f"{side}_gf_per_match_w4",
        f"{side}_ga_per_match_w4",
        f"{side}_gf_per_match_w6",
        f"{side}_ga_per_match_w6",
        f"{side}_gf_per_match_std",
        f"{side}_ga_per_match_std",
    )
)
HISTORY_METRICS = (
    "sample_count",
    "minutes",
    "minutes_per_match",
    "appearance_rate",
    "start_rate",
    "points_per90",
    "xg_per90",
    "xa_per90",
    "xgc_per90",
    "clean_sheet_rate",
    "saves_per90",
    "bonus_per90",
    "goals_per90",
    "assists_per90",
    "cards_per90",
    "defensive_contribution_per90",
    "defensive_data_share",
)
HISTORY_FEATURES = tuple(
    f"history_{metric}_{suffix}"
    for suffix in ("w2", "w4", "w6", "std")
    for metric in HISTORY_METRICS
)
FEATURE_NAMES = CONTEXT_FEATURES + TEAM_FEATURES + HISTORY_FEATURES

POSITION_PRIORS = {
    "GK": {
        "minutes_per_match": 58.0,
        "appearance_rate": 0.67,
        "start_rate": 0.64,
        "points_per90": 4.0,
        "xg_per90": 0.002,
        "xa_per90": 0.01,
        "xgc_per90": 1.40,
        "clean_sheet_rate": 0.27,
        "saves_per90": 3.0,
        "bonus_per90": 0.30,
        "goals_per90": 0.001,
        "assists_per90": 0.01,
        "cards_per90": 0.04,
        "defensive_contribution_per90": 2.0,
    },
    "DEF": {
        "minutes_per_match": 52.0,
        "appearance_rate": 0.64,
        "start_rate": 0.57,
        "points_per90": 3.8,
        "xg_per90": 0.06,
        "xa_per90": 0.08,
        "xgc_per90": 1.40,
        "clean_sheet_rate": 0.25,
        "saves_per90": 0.0,
        "bonus_per90": 0.25,
        "goals_per90": 0.05,
        "assists_per90": 0.07,
        "cards_per90": 0.13,
        "defensive_contribution_per90": 8.0,
    },
    "MID": {
        "minutes_per_match": 49.0,
        "appearance_rate": 0.65,
        "start_rate": 0.53,
        "points_per90": 4.2,
        "xg_per90": 0.18,
        "xa_per90": 0.17,
        "xgc_per90": 1.40,
        "clean_sheet_rate": 0.22,
        "saves_per90": 0.0,
        "bonus_per90": 0.30,
        "goals_per90": 0.16,
        "assists_per90": 0.15,
        "cards_per90": 0.12,
        "defensive_contribution_per90": 6.0,
    },
    "FWD": {
        "minutes_per_match": 46.0,
        "appearance_rate": 0.62,
        "start_rate": 0.49,
        "points_per90": 4.5,
        "xg_per90": 0.32,
        "xa_per90": 0.12,
        "xgc_per90": 1.40,
        "clean_sheet_rate": 0.0,
        "saves_per90": 0.0,
        "bonus_per90": 0.35,
        "goals_per90": 0.28,
        "assists_per90": 0.10,
        "cards_per90": 0.10,
        "defensive_contribution_per90": 3.0,
    },
}

GB_CLASSIFIER_PARAMS = {
    "loss": "log_loss",
    "learning_rate": 0.04,
    "n_estimators": 120,
    "subsample": 0.8,
    "max_depth": 2,
    "min_samples_leaf": 30,
    "max_features": None,
}
GB_REGRESSOR_PARAMS = {
    "loss": "huber",
    "alpha": 0.9,
    "learning_rate": 0.04,
    "n_estimators": 120,
    "subsample": 0.8,
    "max_depth": 2,
    "min_samples_leaf": 30,
    "max_features": None,
}
BLEND_CANDIDATES = (0.0, 0.25, 0.5, 0.75, 1.0)


class PipelineError(RuntimeError):
    """An actionable pipeline error."""


@dataclass(frozen=True)
class RawRow:
    season: str
    gameweek: int
    fixture_id: int
    player_id: int
    player_name: str
    position: str
    team_id: int
    team_name: str
    opponent_id: int
    kickoff: datetime
    was_home: bool
    price_m: float
    minutes: float
    starts: float
    total_points: float
    expected_goals: float
    expected_assists: float
    expected_goals_conceded: float
    clean_sheets: float
    saves: float
    bonus: float
    goals: float
    assists: float
    cards: float
    defensive_contribution: float | None
    home_score: float | None
    away_score: float | None


@dataclass(frozen=True)
class TargetFixtureContext:
    season: str
    gameweek: int
    fixture_id: int
    player_id: int
    player_name: str
    position: str
    team_id: int
    team_name: str
    opponent_id: int
    kickoff: datetime
    was_home: bool
    price_m: float


@dataclass(frozen=True)
class PlayerEvent:
    gameweek: int
    kickoff: datetime
    minutes: float
    appearance: float
    start: float
    total_points: float
    expected_goals: float
    expected_assists: float
    expected_goals_conceded: float
    clean_sheets: float
    saves: float
    bonus: float
    goals: float
    assists: float
    cards: float
    defensive_contribution: float | None


@dataclass
class PlayerState:
    events: list[PlayerEvent] = field(default_factory=list)
    last_price_m: float | None = None


@dataclass(frozen=True)
class TeamEvent:
    gameweek: int
    kickoff: datetime
    goals_for: float
    goals_against: float


@dataclass(frozen=True)
class MatchOutcome:
    fixture_id: int
    gameweek: int
    kickoff: datetime
    home_id: int
    away_id: int
    home_score: float
    away_score: float


@dataclass
class DatasetArrays:
    X: Any
    appearance: Any
    start: Any
    minutes: Any
    points: Any
    metadata: dict[str, list[Any]]


def _parse_float(
    value: str | None,
    label: str,
    source: Path,
    line_number: int,
    *,
    blank: float | None = 0.0,
) -> float | None:
    if value is None or value.strip() == "":
        if blank is not None:
            return blank
        return None
    try:
        result = float(value)
    except ValueError as exc:
        raise PipelineError(
            f"{source}:{line_number}: invalid numeric {label}={value!r}"
        ) from exc
    if not math.isfinite(result):
        raise PipelineError(
            f"{source}:{line_number}: non-finite numeric {label}={value!r}"
        )
    return result


def _parse_int(value: str | None, label: str, source: Path, line_number: int) -> int:
    parsed = _parse_float(value, label, source, line_number, blank=None)
    if parsed is None or not parsed.is_integer():
        raise PipelineError(f"{source}:{line_number}: invalid integer {label}={value!r}")
    return int(parsed)


def _parse_bool(value: str | None, label: str, source: Path, line_number: int) -> bool:
    normalized = (value or "").strip().lower()
    if normalized in {"true", "1", "yes"}:
        return True
    if normalized in {"false", "0", "no"}:
        return False
    raise PipelineError(f"{source}:{line_number}: invalid boolean {label}={value!r}")


def _parse_datetime(value: str | None, source: Path, line_number: int) -> datetime:
    if not value:
        raise PipelineError(f"{source}:{line_number}: missing kickoff_time")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PipelineError(
            f"{source}:{line_number}: invalid kickoff_time={value!r}"
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _first(row: dict[str, str], names: Sequence[str]) -> str | None:
    for name in names:
        if name in row:
            return row[name]
    return None


def _iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _format_float(value: float) -> str:
    if not math.isfinite(value):
        raise PipelineError(f"attempted to write non-finite value {value!r}")
    return format(value, ".10g")


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True, ensure_ascii=True, allow_nan=False)
            handle.write("\n")
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _check_outputs(paths: Iterable[Path], overwrite: bool) -> None:
    existing = [str(path) for path in paths if path.exists()]
    if existing and not overwrite:
        joined = ", ".join(existing)
        raise PipelineError(f"output already exists: {joined}; pass --overwrite to replace it")


def _validate_feature_contract() -> None:
    duplicates = sorted({name for name in FEATURE_NAMES if FEATURE_NAMES.count(name) > 1})
    if duplicates:
        raise PipelineError(f"duplicate fitted feature names: {duplicates}")
    exact_forbidden = set(IDENTITY_FIELDS_EXCLUDED)
    leaked = sorted(exact_forbidden.intersection(FEATURE_NAMES))
    if leaked:
        raise PipelineError(f"identity fields leaked into fitted features: {leaked}")
    if tuple(name for name in FEATURE_NAMES if name.startswith("position_")) != (
        "position_gk",
        "position_def",
        "position_mid",
        "position_fwd",
    ):
        raise PipelineError("position feature contract must be fixed one-hot GK/DEF/MID/FWD")


def _load_teams(path: Path) -> tuple[dict[str, int], set[int]]:
    if not path.is_file():
        raise PipelineError(f"missing team mapping: {path}")
    by_name: dict[str, int] = {}
    ids: set[int] = set()
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or not {"id", "name"}.issubset(reader.fieldnames):
            raise PipelineError(f"{path}: teams.csv must contain id and name")
        for row in reader:
            team_id = _parse_int(row.get("id"), "id", path, reader.line_num)
            name = (row.get("name") or "").strip()
            if not name:
                raise PipelineError(f"{path}:{reader.line_num}: missing team name")
            if name in by_name or team_id in ids:
                raise PipelineError(f"{path}:{reader.line_num}: duplicate team name or id")
            by_name[name] = team_id
            ids.add(team_id)
    if len(ids) != 20:
        raise PipelineError(f"{path}: expected 20 teams, found {len(ids)}")
    return by_name, ids


def _resolve_season_dir(historical_dir: Path, season: str) -> Path:
    direct = historical_dir / season
    candidates = (direct, direct / "reconstructed")
    for candidate in candidates:
        if (candidate / "teams.csv").is_file():
            return candidate
    checked = ", ".join(str(candidate) for candidate in candidates)
    raise PipelineError(f"missing required season data for {season}; checked {checked}")


def _load_gameweek(
    path: Path,
    season: str,
    gameweek: int,
    teams_by_name: dict[str, int],
    valid_team_ids: set[int],
) -> tuple[list[RawRow], int, int]:
    required = {
        "name",
        "position",
        "team",
        "element",
        "fixture",
        "round",
        "kickoff_time",
        "minutes",
        "starts",
        "total_points",
        "value",
        "was_home",
        "opponent_team",
        "expected_goals",
        "expected_assists",
        "expected_goals_conceded",
        "clean_sheets",
        "saves",
        "bonus",
        "assists",
        "yellow_cards",
        "red_cards",
        "team_h_score",
        "team_a_score",
    }
    rows: list[RawRow] = []
    raw_count = 0
    am_count = 0
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        fields = set(reader.fieldnames or ())
        missing = sorted(required - fields)
        if "goals_scored" not in fields and "goals" not in fields:
            missing.append("goals_scored (or goals)")
        if missing:
            raise PipelineError(f"{path}: missing required columns: {', '.join(missing)}")
        for source_row in reader:
            raw_count += 1
            position = (source_row.get("position") or "").strip().upper()
            if position == "AM":
                am_count += 1
                continue
            if position not in POSITIONS:
                raise PipelineError(
                    f"{path}:{reader.line_num}: unsupported position={position!r}"
                )
            row_gameweek = _parse_int(
                source_row.get("round"), "round", path, reader.line_num
            )
            if row_gameweek != gameweek:
                raise PipelineError(
                    f"{path}:{reader.line_num}: round {row_gameweek} does not match GW {gameweek}"
                )
            team_name = (source_row.get("team") or "").strip()
            if team_name not in teams_by_name:
                raise PipelineError(
                    f"{path}:{reader.line_num}: team {team_name!r} is absent from teams.csv"
                )
            opponent_id = _parse_int(
                source_row.get("opponent_team"), "opponent_team", path, reader.line_num
            )
            if opponent_id not in valid_team_ids:
                raise PipelineError(
                    f"{path}:{reader.line_num}: unknown opponent_team={opponent_id}"
                )
            team_id = teams_by_name[team_name]
            if team_id == opponent_id:
                raise PipelineError(f"{path}:{reader.line_num}: club cannot oppose itself")
            yellow = _parse_float(
                source_row.get("yellow_cards"), "yellow_cards", path, reader.line_num
            )
            red = _parse_float(
                source_row.get("red_cards"), "red_cards", path, reader.line_num
            )
            defensive = None
            if "defensive_contribution" in source_row:
                defensive = _parse_float(
                    source_row.get("defensive_contribution"),
                    "defensive_contribution",
                    path,
                    reader.line_num,
                    blank=0.0,
                )
            rows.append(
                RawRow(
                    season=season,
                    gameweek=gameweek,
                    fixture_id=_parse_int(
                        source_row.get("fixture"), "fixture", path, reader.line_num
                    ),
                    player_id=_parse_int(
                        source_row.get("element"), "element", path, reader.line_num
                    ),
                    player_name=(source_row.get("name") or "").strip(),
                    position=position,
                    team_id=team_id,
                    team_name=team_name,
                    opponent_id=opponent_id,
                    kickoff=_parse_datetime(
                        source_row.get("kickoff_time"), path, reader.line_num
                    ),
                    was_home=_parse_bool(
                        source_row.get("was_home"), "was_home", path, reader.line_num
                    ),
                    price_m=float(
                        _parse_float(
                            source_row.get("value"), "value", path, reader.line_num
                        )
                    )
                    / 10.0,
                    minutes=float(
                        _parse_float(
                            source_row.get("minutes"), "minutes", path, reader.line_num
                        )
                    ),
                    starts=float(
                        _parse_float(
                            source_row.get("starts"), "starts", path, reader.line_num
                        )
                    ),
                    total_points=float(
                        _parse_float(
                            source_row.get("total_points"),
                            "total_points",
                            path,
                            reader.line_num,
                        )
                    ),
                    expected_goals=float(
                        _parse_float(
                            source_row.get("expected_goals"),
                            "expected_goals",
                            path,
                            reader.line_num,
                        )
                    ),
                    expected_assists=float(
                        _parse_float(
                            source_row.get("expected_assists"),
                            "expected_assists",
                            path,
                            reader.line_num,
                        )
                    ),
                    expected_goals_conceded=float(
                        _parse_float(
                            source_row.get("expected_goals_conceded"),
                            "expected_goals_conceded",
                            path,
                            reader.line_num,
                        )
                    ),
                    clean_sheets=float(
                        _parse_float(
                            source_row.get("clean_sheets"),
                            "clean_sheets",
                            path,
                            reader.line_num,
                        )
                    ),
                    saves=float(
                        _parse_float(source_row.get("saves"), "saves", path, reader.line_num)
                    ),
                    bonus=float(
                        _parse_float(source_row.get("bonus"), "bonus", path, reader.line_num)
                    ),
                    goals=float(
                        _parse_float(
                            _first(source_row, ("goals_scored", "goals")),
                            "goals_scored",
                            path,
                            reader.line_num,
                        )
                    ),
                    assists=float(
                        _parse_float(
                            source_row.get("assists"), "assists", path, reader.line_num
                        )
                    ),
                    cards=float(yellow) + float(red),
                    defensive_contribution=(
                        None if defensive is None else float(defensive)
                    ),
                    home_score=_parse_float(
                        source_row.get("team_h_score"),
                        "team_h_score",
                        path,
                        reader.line_num,
                        blank=None,
                    ),
                    away_score=_parse_float(
                        source_row.get("team_a_score"),
                        "team_a_score",
                        path,
                        reader.line_num,
                        blank=None,
                    ),
                )
            )
    if not rows and raw_count == 0:
        return [], 0, 0
    if not rows:
        raise PipelineError(f"{path}: no player rows after filtering AM records")
    return rows, raw_count, am_count


def _eligible_player_events(
    events: Sequence[PlayerEvent],
    target_gameweek: int,
    kickoff: datetime,
    window: int | None,
) -> list[PlayerEvent]:
    lower = 1 if window is None else max(1, target_gameweek - window)
    return [
        event
        for event in events
        if lower <= event.gameweek < target_gameweek and event.kickoff < kickoff
    ]


def _player_summary(
    events: Sequence[PlayerEvent],
    position: str,
    target_gameweek: int,
    kickoff: datetime,
    window: int | None,
) -> dict[str, float]:
    eligible = _eligible_player_events(events, target_gameweek, kickoff, window)
    prior = POSITION_PRIORS[position]
    count = len(eligible)
    minutes = sum(event.minutes for event in eligible)
    appearances = sum(event.appearance for event in eligible)
    fixture_prior = 5.0 if window is None else 3.0
    minute_prior = 360.0 if window is None else 180.0

    result = {
        "sample_count": float(count),
        "minutes": minutes,
        "minutes_per_match": (
            minutes + prior["minutes_per_match"] * fixture_prior
        )
        / (count + fixture_prior),
        "appearance_rate": (
            appearances + prior["appearance_rate"] * fixture_prior
        )
        / (count + fixture_prior),
        "start_rate": (
            sum(event.start for event in eligible)
            + prior["start_rate"] * fixture_prior
        )
        / (count + fixture_prior),
    }
    sums = {
        "points_per90": sum(event.total_points for event in eligible),
        "xg_per90": sum(event.expected_goals for event in eligible),
        "xa_per90": sum(event.expected_assists for event in eligible),
        "xgc_per90": sum(event.expected_goals_conceded for event in eligible),
        "saves_per90": sum(event.saves for event in eligible),
        "bonus_per90": sum(event.bonus for event in eligible),
        "goals_per90": sum(event.goals for event in eligible),
        "assists_per90": sum(event.assists for event in eligible),
        "cards_per90": sum(event.cards for event in eligible),
    }
    for metric, total in sums.items():
        result[metric] = (total * 90.0 + prior[metric] * minute_prior) / (
            minutes + minute_prior
        )
    clean_prior = max(2.0, fixture_prior * prior["appearance_rate"])
    result["clean_sheet_rate"] = (
        sum(event.clean_sheets for event in eligible)
        + prior["clean_sheet_rate"] * clean_prior
    ) / (appearances + clean_prior)

    defensive_events = [
        event for event in eligible if event.defensive_contribution is not None
    ]
    defensive_minutes = sum(event.minutes for event in defensive_events)
    defensive_total = sum(
        float(event.defensive_contribution) for event in defensive_events
    )
    result["defensive_contribution_per90"] = (
        defensive_total * 90.0
        + prior["defensive_contribution_per90"] * minute_prior
    ) / (defensive_minutes + minute_prior)
    result["defensive_data_share"] = (
        len(defensive_events) / count if count else 0.0
    )
    return result


def _eligible_team_events(
    events: Sequence[TeamEvent],
    target_gameweek: int,
    kickoff: datetime,
    window: int | None,
) -> list[TeamEvent]:
    lower = 1 if window is None else max(1, target_gameweek - window)
    return [
        event
        for event in events
        if lower <= event.gameweek < target_gameweek and event.kickoff < kickoff
    ]


def _team_rates(
    events: Sequence[TeamEvent],
    target_gameweek: int,
    kickoff: datetime,
    window: int | None,
) -> tuple[float, float, float]:
    eligible = _eligible_team_events(events, target_gameweek, kickoff, window)
    pseudo_matches = 5.0 if window is None else 3.0
    league_goal_prior = 1.35
    count = len(eligible)
    goals_for = sum(event.goals_for for event in eligible)
    goals_against = sum(event.goals_against for event in eligible)
    denominator = count + pseudo_matches
    return (
        float(count),
        (goals_for + league_goal_prior * pseudo_matches) / denominator,
        (goals_against + league_goal_prior * pseudo_matches) / denominator,
    )


def _rest_features(
    events: Sequence[TeamEvent],
    target_gameweek: int,
    kickoff: datetime,
    scheduled_gameweek_kickoffs: Sequence[datetime] = (),
) -> tuple[float, float]:
    eligible = _eligible_team_events(events, target_gameweek, kickoff, None)
    known_kickoffs = [event.kickoff for event in eligible]
    known_kickoffs.extend(
        scheduled
        for scheduled in scheduled_gameweek_kickoffs
        if scheduled < kickoff
    )
    if not known_kickoffs:
        return 7.0, 1.0
    latest = max(known_kickoffs)
    days = (kickoff - latest).total_seconds() / 86400.0
    return min(30.0, max(0.0, days)), 0.0


def _build_features(
    row: RawRow | TargetFixtureContext,
    player_states: dict[int, PlayerState],
    team_states: dict[int, list[TeamEvent]],
    club_match_count: int,
    *,
    scoring_defensive_contributions: bool | None = None,
    target_gameweek_kickoffs: Mapping[int, Sequence[datetime]] | None = None,
) -> dict[str, float]:
    player_state = player_states.get(row.player_id)
    prior_events = player_state.events if player_state else ()
    if player_state and player_state.last_price_m is not None:
        known_price = player_state.last_price_m
        cold_start = 0.0
    else:
        known_price = row.price_m
        cold_start = 1.0

    club_events = team_states.get(row.team_id, ())
    opposition_events = team_states.get(row.opponent_id, ())
    club_rest, club_rest_missing = _rest_features(
        club_events,
        row.gameweek,
        row.kickoff,
        (target_gameweek_kickoffs or {}).get(row.team_id, ()),
    )
    opposition_rest, opposition_rest_missing = _rest_features(
        opposition_events,
        row.gameweek,
        row.kickoff,
        (target_gameweek_kickoffs or {}).get(row.opponent_id, ()),
    )
    features: dict[str, float] = {
        "is_home": float(row.was_home),
        "gameweek_phase": (row.gameweek - 1.0) / 37.0,
        "club_gw_match_count": float(club_match_count),
        "known_price_m": known_price,
        "price_cold_start": cold_start,
        "club_rest_days": club_rest,
        "club_rest_missing": club_rest_missing,
        "opposition_rest_days": opposition_rest,
        "opposition_rest_missing": opposition_rest_missing,
        "scoring_defensive_contributions": float(
            row.season == "2025-2026"
            if scoring_defensive_contributions is None
            else scoring_defensive_contributions
        ),
        "position_gk": float(row.position == "GK"),
        "position_def": float(row.position == "DEF"),
        "position_mid": float(row.position == "MID"),
        "position_fwd": float(row.position == "FWD"),
    }

    for side, events in (("club", club_events), ("opposition", opposition_events)):
        std_count, std_gf, std_ga = _team_rates(
            events, row.gameweek, row.kickoff, None
        )
        features[f"{side}_matches_std"] = std_count
        for window in TEAM_WINDOWS:
            _, goals_for, goals_against = _team_rates(
                events, row.gameweek, row.kickoff, window
            )
            features[f"{side}_gf_per_match_w{window}"] = goals_for
            features[f"{side}_ga_per_match_w{window}"] = goals_against
        features[f"{side}_gf_per_match_std"] = std_gf
        features[f"{side}_ga_per_match_std"] = std_ga

    for window in WINDOWS:
        summary = _player_summary(
            prior_events, row.position, row.gameweek, row.kickoff, window
        )
        for metric in HISTORY_METRICS:
            features[f"history_{metric}_w{window}"] = summary[metric]
    summary = _player_summary(
        prior_events, row.position, row.gameweek, row.kickoff, None
    )
    for metric in HISTORY_METRICS:
        features[f"history_{metric}_std"] = summary[metric]

    if tuple(features) != FEATURE_NAMES:
        missing = sorted(set(FEATURE_NAMES) - set(features))
        extra = sorted(set(features) - set(FEATURE_NAMES))
        raise PipelineError(f"feature contract mismatch; missing={missing}, extra={extra}")
    if not all(math.isfinite(value) for value in features.values()):
        raise PipelineError(
            f"non-finite features for {row.season} GW{row.gameweek} player {row.player_id}"
        )
    return features


def build_canonical_feature_vector(
    context: TargetFixtureContext,
    player_states: dict[int, PlayerState],
    team_states: dict[int, list[TeamEvent]],
    club_match_count: int,
    *,
    scoring_defensive_contributions: bool,
    target_gameweek_kickoffs: Mapping[int, Sequence[datetime]],
) -> list[float]:
    """Build the exact ordered float values seen by model training."""
    features = _build_features(
        context,
        player_states,
        team_states,
        club_match_count,
        scoring_defensive_contributions=scoring_defensive_contributions,
        target_gameweek_kickoffs=target_gameweek_kickoffs,
    )
    return [float(_format_float(features[name])) for name in FEATURE_NAMES]


def _match_outcomes(rows: Sequence[RawRow]) -> dict[int, MatchOutcome]:
    outcomes: dict[int, MatchOutcome] = {}
    for row in rows:
        if row.home_score is None or row.away_score is None:
            continue
        home_id = row.team_id if row.was_home else row.opponent_id
        away_id = row.opponent_id if row.was_home else row.team_id
        candidate = MatchOutcome(
            fixture_id=row.fixture_id,
            gameweek=row.gameweek,
            kickoff=row.kickoff,
            home_id=home_id,
            away_id=away_id,
            home_score=row.home_score,
            away_score=row.away_score,
        )
        existing = outcomes.get(row.fixture_id)
        if existing is not None and existing != candidate:
            raise PipelineError(
                f"inconsistent outcome rows for fixture {row.fixture_id} in GW {row.gameweek}"
            )
        outcomes[row.fixture_id] = candidate
    return outcomes


def _deduplicate_gameweek_rows(rows: Sequence[RawRow]) -> tuple[list[RawRow], int]:
    unique: dict[tuple[int, int], RawRow] = {}
    duplicate_count = 0
    for row in rows:
        key = (row.fixture_id, row.player_id)
        existing = unique.get(key)
        if existing is None:
            unique[key] = row
            continue
        if existing != row:
            raise PipelineError(
                f"conflicting canonical rows: {row.season} GW{row.gameweek} "
                f"fixture {row.fixture_id} player {row.player_id}"
            )
        duplicate_count += 1
    return list(unique.values()), duplicate_count


def _update_histories(
    rows: Sequence[RawRow],
    player_states: dict[int, PlayerState],
    team_states: dict[int, list[TeamEvent]],
    seen_team_fixtures: set[int],
) -> tuple[int, int]:
    current_prices: dict[int, float] = {}
    for row in rows:
        prior_price = current_prices.get(row.player_id)
        if prior_price is not None and not math.isclose(prior_price, row.price_m):
            raise PipelineError(
                f"inconsistent GW price for player {row.player_id} in GW {row.gameweek}"
            )
        current_prices[row.player_id] = row.price_m
        state = player_states.setdefault(row.player_id, PlayerState())
        state.events.append(
            PlayerEvent(
                gameweek=row.gameweek,
                kickoff=row.kickoff,
                minutes=row.minutes,
                appearance=float(row.minutes > 0.0),
                start=float(row.starts > 0.0),
                total_points=row.total_points,
                expected_goals=row.expected_goals,
                expected_assists=row.expected_assists,
                expected_goals_conceded=row.expected_goals_conceded,
                clean_sheets=row.clean_sheets,
                saves=row.saves,
                bonus=row.bonus,
                goals=row.goals,
                assists=row.assists,
                cards=row.cards,
                defensive_contribution=row.defensive_contribution,
            )
        )
    for player_id, price in current_prices.items():
        player_states[player_id].last_price_m = price

    updated = 0
    skipped = 0
    for fixture_id, outcome in _match_outcomes(rows).items():
        if fixture_id in seen_team_fixtures:
            skipped += 1
            continue
        seen_team_fixtures.add(fixture_id)
        team_states.setdefault(outcome.home_id, []).append(
            TeamEvent(
                gameweek=outcome.gameweek,
                kickoff=outcome.kickoff,
                goals_for=outcome.home_score,
                goals_against=outcome.away_score,
            )
        )
        team_states.setdefault(outcome.away_id, []).append(
            TeamEvent(
                gameweek=outcome.gameweek,
                kickoff=outcome.kickoff,
                goals_for=outcome.away_score,
                goals_against=outcome.home_score,
            )
        )
        updated += 1
    return updated, skipped


def build_dataset(historical_dir: Path, output_dir: Path, overwrite: bool) -> dict[str, Any]:
    _validate_feature_contract()
    dataset_path = output_dir / "dataset.csv"
    manifest_path = output_dir / "manifest.json"
    _check_outputs((dataset_path, manifest_path), overwrite)
    output_dir.mkdir(parents=True, exist_ok=True)
    temporary = dataset_path.with_suffix(".csv.tmp")
    season_stats: dict[str, dict[str, Any]] = {}
    total_rows = 0
    total_raw_rows = 0
    total_am_rows = 0
    total_duplicate_rows = 0
    try:
        with temporary.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(METADATA_FIELDS + FEATURE_NAMES + TARGET_FIELDS)
            for season in SEASONS:
                season_dir = _resolve_season_dir(historical_dir, season)
                teams_by_name, valid_team_ids = _load_teams(season_dir / "teams.csv")
                missing_gws = [
                    gameweek
                    for gameweek in range(1, 39)
                    if not (season_dir / f"gw-raw-{gameweek}.csv").is_file()
                ]
                if missing_gws:
                    missing_text = ", ".join(str(value) for value in missing_gws)
                    raise PipelineError(f"{season_dir}: missing gameweek CSVs: {missing_text}")

                player_states: dict[int, PlayerState] = {}
                team_states: dict[int, list[TeamEvent]] = {}
                seen_team_fixtures: set[int] = set()
                seen_canonical_keys: set[tuple[int, int, int]] = set()
                kept = 0
                raw = 0
                am = 0
                fixture_updates = 0
                fixture_update_duplicates = 0
                duplicate_rows = 0
                cutoff: datetime | None = None
                for gameweek in range(1, 39):
                    source = season_dir / f"gw-raw-{gameweek}.csv"
                    rows, raw_count, am_count = _load_gameweek(
                        source,
                        season,
                        gameweek,
                        teams_by_name,
                        valid_team_ids,
                    )
                    raw += raw_count
                    am += am_count
                    rows, duplicates = _deduplicate_gameweek_rows(rows)
                    duplicate_rows += duplicates
                    fixtures_by_club: dict[int, set[int]] = defaultdict(set)
                    kickoffs_by_club: dict[int, set[datetime]] = defaultdict(set)
                    for row in rows:
                        fixtures_by_club[row.team_id].add(row.fixture_id)
                        kickoffs_by_club[row.team_id].add(row.kickoff)

                    # All target rows are materialized before any GW history is updated.
                    for row in rows:
                        key = (row.gameweek, row.fixture_id, row.player_id)
                        if key in seen_canonical_keys:
                            raise PipelineError(
                                f"duplicate canonical row: {season} GW{row.gameweek} "
                                f"fixture {row.fixture_id} player {row.player_id}"
                            )
                        seen_canonical_keys.add(key)
                        features = _build_features(
                            row,
                            player_states,
                            team_states,
                            len(fixtures_by_club[row.team_id]),
                            target_gameweek_kickoffs=kickoffs_by_club,
                        )
                        writer.writerow(
                            (
                                row.season,
                                row.gameweek,
                                row.fixture_id,
                                row.player_id,
                                row.player_name,
                                row.position,
                                row.team_id,
                                row.team_name,
                                row.opponent_id,
                                _iso_z(row.kickoff),
                            )
                            + tuple(_format_float(features[name]) for name in FEATURE_NAMES)
                            + (
                                int(row.minutes > 0.0),
                                int(row.starts > 0.0),
                                _format_float(row.minutes),
                                _format_float(row.total_points),
                            )
                        )
                        kept += 1
                        cutoff = row.kickoff if cutoff is None else max(cutoff, row.kickoff)
                    updated, skipped = _update_histories(
                        rows, player_states, team_states, seen_team_fixtures
                    )
                    fixture_updates += updated
                    fixture_update_duplicates += skipped

                season_stats[season] = {
                    "rows": kept,
                    "raw_rows": raw,
                    "am_rows_discarded": am,
                    "exact_duplicate_rows_discarded": duplicate_rows,
                    "completed_fixtures_deduplicated": fixture_updates,
                    "duplicate_fixture_updates_discarded": fixture_update_duplicates,
                    "latest_kickoff": _iso_z(cutoff) if cutoff else None,
                }
                total_rows += kept
                total_raw_rows += raw
                total_am_rows += am
                total_duplicate_rows += duplicate_rows
        temporary.replace(dataset_path)
    finally:
        if temporary.exists():
            temporary.unlink()

    manifest = {
        "data_version": DATA_VERSION,
        "schema_version": SCHEMA_VERSION,
        "grain": ["season", "target_gameweek", "fixture_id", "player_id"],
        "seasons": list(SEASONS),
        "row_count": total_rows,
        "raw_row_count": total_raw_rows,
        "am_rows_discarded": total_am_rows,
        "exact_duplicate_rows_discarded": total_duplicate_rows,
        "feature_count": len(FEATURE_NAMES),
        "feature_names": list(FEATURE_NAMES),
        "metadata_fields": list(METADATA_FIELDS),
        "target_fields": list(TARGET_FIELDS),
        "identity_fields_excluded_from_features": list(IDENTITY_FIELDS_EXCLUDED),
        "season_stats": season_stats,
        "source": {
            "directory": str(historical_dir),
            "strict_deadline_snapshots": False,
            "description": "Reconstructed historical GW exports; not strict as-of snapshots.",
        },
        "leakage_controls": [
            "Only rows from lower-numbered gameweeks can enter rolling histories.",
            "Every row in a target gameweek is built before player or club histories update.",
            "Rolling match events must also have kickoff earlier than the target kickoff.",
            "Current-row outcomes and post-kickoff statistics are targets/history updates only.",
            "Current price is used only on a player's cold-start row; otherwise prior price is used.",
        ],
    }
    _write_json(manifest_path, manifest)
    print(f"built {dataset_path} ({total_rows:,} rows, {len(FEATURE_NAMES)} features)")
    print(f"wrote {manifest_path}")
    return manifest


def _require_ml_dependencies() -> tuple[Any, Any, Any]:
    try:
        import numpy as np
        from sklearn.ensemble import GradientBoostingClassifier, GradientBoostingRegressor
    except ImportError as exc:
        raise PipelineError(
            "training requires NumPy and scikit-learn; create a local venv and run "
            "`python -m pip install -r requirements-ml.txt`"
        ) from exc
    return np, GradientBoostingClassifier, GradientBoostingRegressor


def _load_dataset(dataset_path: Path, manifest_path: Path, np: Any) -> tuple[DatasetArrays, dict[str, Any]]:
    if not dataset_path.is_file():
        raise PipelineError(f"missing built dataset: {dataset_path}; run the build command first")
    if not manifest_path.is_file():
        raise PipelineError(f"missing dataset manifest: {manifest_path}; run the build command first")
    with manifest_path.open("r", encoding="utf-8") as handle:
        manifest = json.load(handle)
    if manifest.get("schema_version") != SCHEMA_VERSION:
        raise PipelineError(
            f"unsupported dataset schema {manifest.get('schema_version')!r}; rebuild the dataset"
        )
    if manifest.get("feature_names") != list(FEATURE_NAMES):
        raise PipelineError("dataset feature order differs from the fitted feature contract")
    expected_rows = int(manifest.get("row_count", 0))
    if expected_rows <= 0:
        raise PipelineError(f"{manifest_path}: invalid row_count")

    X = np.empty((expected_rows, len(FEATURE_NAMES)), dtype=np.float64)
    appearance = np.empty(expected_rows, dtype=np.float64)
    start = np.empty(expected_rows, dtype=np.float64)
    minutes = np.empty(expected_rows, dtype=np.float64)
    points = np.empty(expected_rows, dtype=np.float64)
    metadata: dict[str, list[Any]] = {name: [None] * expected_rows for name in METADATA_FIELDS}
    expected_header = set(METADATA_FIELDS + FEATURE_NAMES + TARGET_FIELDS)

    with dataset_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        actual_header = set(reader.fieldnames or ())
        missing = sorted(expected_header - actual_header)
        if missing:
            raise PipelineError(f"{dataset_path}: missing columns: {', '.join(missing)}")
        index = 0
        for row in reader:
            if index >= expected_rows:
                raise PipelineError(
                    f"{dataset_path}: contains more rows than manifest row_count={expected_rows}"
                )
            try:
                X[index, :] = [float(row[name]) for name in FEATURE_NAMES]
                appearance[index] = float(row["target_appearance"])
                start[index] = float(row["target_start"])
                minutes[index] = float(row["target_minutes"])
                points[index] = float(row["target_total_points"])
                for name in METADATA_FIELDS:
                    value: Any = row[name]
                    if name in {
                        "target_gameweek",
                        "fixture_id",
                        "player_id",
                        "team_id",
                        "opponent_id",
                    }:
                        value = int(value)
                    metadata[name][index] = value
            except (TypeError, ValueError) as exc:
                raise PipelineError(
                    f"{dataset_path}:{reader.line_num}: invalid numeric dataset value"
                ) from exc
            index += 1
    if index != expected_rows:
        raise PipelineError(
            f"{dataset_path}: manifest expects {expected_rows} rows, found {index}"
        )
    if not np.isfinite(X).all():
        raise PipelineError(f"{dataset_path}: feature matrix contains non-finite values")
    return DatasetArrays(X, appearance, start, minutes, points, metadata), manifest


def _serializable_params(model: Any) -> dict[str, Any]:
    names = (
        "loss",
        "alpha",
        "learning_rate",
        "n_estimators",
        "subsample",
        "max_depth",
        "min_samples_leaf",
        "max_features",
        "random_state",
    )
    params = model.get_params()
    return {name: params[name] for name in names if name in params}


def _serialize_gradient_boosting(
    model: Any, task: str, feature_count: int, np: Any
) -> dict[str, Any]:
    if task not in {"binary_classification", "regression"}:
        raise PipelineError(f"unsupported serialization task {task}")
    if task == "binary_classification" and list(model.classes_) != [0.0, 1.0]:
        raise PipelineError(f"binary classifier has unexpected classes {model.classes_!r}")
    base_score = float(
        model._raw_predict_init(np.zeros((1, feature_count), dtype=np.float64))[0, 0]
    )
    trees = []
    for stage in model.estimators_:
        if len(stage) != 1:
            raise PipelineError("only scalar binary/regression gradient boosting is supported")
        tree = stage[0].tree_
        trees.append(
            {
                "node_count": int(tree.node_count),
                "children_left": tree.children_left.astype(int).tolist(),
                "children_right": tree.children_right.astype(int).tolist(),
                "feature_index": tree.feature.astype(int).tolist(),
                "threshold": tree.threshold.astype(float).tolist(),
                "value": tree.value[:, 0, 0].astype(float).tolist(),
            }
        )
    result = {
        "task": task,
        "link": "sigmoid" if task == "binary_classification" else "identity",
        "base_score": base_score,
        "learning_rate": float(model.learning_rate),
        "trees": trees,
        "hyperparameters": _serializable_params(model),
    }
    if task == "binary_classification":
        result["base_log_odds"] = base_score
        result["base_probability"] = 1.0 / (1.0 + math.exp(-base_score))
    return result


def predict_serialized_one(model: dict[str, Any], features: Sequence[float]) -> float:
    """Evaluate one exported scalar gradient-boosting model without sklearn."""
    raw = float(model["base_score"])
    learning_rate = float(model["learning_rate"])
    for tree in model["trees"]:
        node = 0
        children_left = tree["children_left"]
        children_right = tree["children_right"]
        while children_left[node] != -1:
            feature_index = tree["feature_index"][node]
            if features[feature_index] <= tree["threshold"][node]:
                node = children_left[node]
            else:
                node = children_right[node]
        raw += learning_rate * tree["value"][node]
    if model["link"] == "identity":
        return raw
    if model["link"] != "sigmoid":
        raise PipelineError(f"unsupported exported link {model['link']!r}")
    if raw >= 0.0:
        return 1.0 / (1.0 + math.exp(-raw))
    exp_raw = math.exp(raw)
    return exp_raw / (1.0 + exp_raw)


def _self_check_models(
    models: dict[str, Any],
    serialized: dict[str, Any],
    X: Any,
    np: Any,
) -> dict[str, Any]:
    sample_count = min(1024, len(X))
    indices = np.unique(np.linspace(0, len(X) - 1, sample_count, dtype=int))
    sample = X[indices]
    max_errors: dict[str, float] = {}
    reference_outputs: dict[str, Any] = {}
    for name, sklearn_model in models.items():
        exported_model = serialized[name]
        portable = np.asarray(
            [predict_serialized_one(exported_model, row) for row in sample],
            dtype=np.float64,
        )
        if exported_model["task"] == "binary_classification":
            expected = sklearn_model.predict_proba(sample)[:, 1]
        else:
            expected = sklearn_model.predict(sample)
        reference_outputs[name] = expected
        error = float(np.max(np.abs(expected - portable)))
        max_errors[name] = error
        if error > SELF_CHECK_TOLERANCE:
            raise PipelineError(
                f"JSON inference self-check failed for {name}: {error:.3g} > "
                f"{SELF_CHECK_TOLERANCE:.3g}"
            )
    parity_positions = np.unique(
        np.linspace(0, len(sample) - 1, min(8, len(sample)), dtype=int)
    )
    return {
        "passed": True,
        "sample_rows": int(len(indices)),
        "absolute_tolerance": SELF_CHECK_TOLERANCE,
        "maximum_absolute_error_by_model": max_errors,
        "parity_vectors": [
            {
                "features": [float(value) for value in sample[int(position)]],
                "expected_outputs": {
                    name: float(outputs[int(position)])
                    for name, outputs in reference_outputs.items()
                },
            }
            for position in parity_positions
        ],
    }


def _predict_models(models: dict[str, Any], X: Any, np: Any) -> dict[str, Any]:
    appearance_probability = models["appearance_classifier"].predict_proba(X)[:, 1]
    raw_start_probability = models["start_classifier"].predict_proba(X)[:, 1]
    conditional_minutes = np.clip(
        models["conditional_minutes_regressor"].predict(X), 1.0, 90.0
    )
    conditional_points = models["conditional_points_regressor"].predict(X)
    direct_points = models["direct_points_regressor"].predict(X)
    return {
        "appearance_probability": appearance_probability,
        "start_probability": np.minimum(raw_start_probability, appearance_probability),
        "raw_start_probability": raw_start_probability,
        "conditional_minutes": conditional_minutes,
        "expected_minutes": appearance_probability * conditional_minutes,
        "conditional_points": conditional_points,
        "appearance_times_conditional_points": appearance_probability
        * conditional_points,
        "direct_points": direct_points,
    }


def _fit_position_price_baseline(
    positions: Sequence[str], prices: Any, targets: Any
) -> dict[str, Any]:
    global_sum = float(sum(float(value) for value in targets))
    global_count = len(targets)
    global_mean = global_sum / global_count
    position_totals: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    cell_totals: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])
    for position, price, target in zip(positions, prices, targets):
        position_totals[position][0] += float(target)
        position_totals[position][1] += 1.0
        price_bin = int(math.floor(float(price) * 2.0 + 0.5))
        key = f"{position}|{price_bin}"
        cell_totals[key][0] += float(target)
        cell_totals[key][1] += 1.0
    position_means = {
        position: (values[0] + 20.0 * global_mean) / (values[1] + 20.0)
        for position, values in position_totals.items()
    }
    cells = {}
    for key, values in cell_totals.items():
        position = key.split("|", 1)[0]
        fallback = position_means.get(position, global_mean)
        cells[key] = (values[0] + 20.0 * fallback) / (values[1] + 20.0)
    return {
        "description": "Training-season position and 0.5m price-bin mean with shrinkage.",
        "global_mean": global_mean,
        "position_means": position_means,
        "position_price_means": cells,
        "cell_prior_samples": 20,
    }


def _predict_position_price_baseline(
    baseline: dict[str, Any], positions: Sequence[str], prices: Any, np: Any
) -> Any:
    predictions = []
    for position, price in zip(positions, prices):
        key = f"{position}|{int(math.floor(float(price) * 2.0 + 0.5))}"
        prediction = baseline["position_price_means"].get(
            key,
            baseline["position_means"].get(position, baseline["global_mean"]),
        )
        predictions.append(prediction)
    return np.asarray(predictions, dtype=np.float64)


def _rankdata(values: Any, np: Any) -> Any:
    order = np.argsort(values, kind="mergesort")
    ranks = np.empty(len(values), dtype=np.float64)
    start = 0
    while start < len(values):
        end = start + 1
        while end < len(values) and values[order[end]] == values[order[start]]:
            end += 1
        rank = (start + end - 1) / 2.0
        ranks[order[start:end]] = rank
        start = end
    return ranks


def _spearman(actual: Any, predicted: Any, np: Any) -> float | None:
    if len(actual) < 2:
        return None
    actual_ranks = _rankdata(actual, np)
    predicted_ranks = _rankdata(predicted, np)
    if np.std(actual_ranks) == 0.0 or np.std(predicted_ranks) == 0.0:
        return None
    return float(np.corrcoef(actual_ranks, predicted_ranks)[0, 1])


def _regression_metrics(actual: Any, predicted: Any, np: Any) -> dict[str, Any]:
    if len(actual) == 0:
        return {"rows": 0, "mae": None, "rmse": None, "bias": None, "spearman": None}
    errors = predicted - actual
    return {
        "rows": int(len(actual)),
        "mae": float(np.mean(np.abs(errors))),
        "rmse": float(np.sqrt(np.mean(errors * errors))),
        "bias": float(np.mean(errors)),
        "spearman": _spearman(actual, predicted, np),
    }


def _mean_gameweek_spearman(
    seasons: Sequence[str], gameweeks: Sequence[int], actual: Any, predicted: Any, np: Any
) -> float | None:
    groups: dict[tuple[str, int], list[int]] = defaultdict(list)
    for index, key in enumerate(zip(seasons, gameweeks)):
        groups[key].append(index)
    correlations = []
    for indices in groups.values():
        if len(indices) < 3:
            continue
        correlation = _spearman(actual[indices], predicted[indices], np)
        if correlation is not None:
            correlations.append(correlation)
    return float(np.mean(correlations)) if correlations else None


def _hierarchical_metrics(
    metadata: dict[str, list[Any]],
    actual: Any,
    predicted: Any,
    activity: Any,
    np: Any,
) -> dict[str, Any]:
    active = activity > 0.0
    fixture_metrics = _regression_metrics(actual, predicted, np)
    fixture_metrics["mean_gameweek_spearman"] = _mean_gameweek_spearman(
        metadata["season"], metadata["target_gameweek"], actual, predicted, np
    )
    active_metrics = _regression_metrics(actual[active], predicted[active], np)
    active_seasons = [value for value, keep in zip(metadata["season"], active) if keep]
    active_gameweeks = [
        value for value, keep in zip(metadata["target_gameweek"], active) if keep
    ]
    active_metrics["mean_gameweek_spearman"] = _mean_gameweek_spearman(
        active_seasons,
        active_gameweeks,
        actual[active],
        predicted[active],
        np,
    )

    grouped: dict[tuple[str, int, int], list[float]] = {}
    for index in range(len(actual)):
        key = (
            metadata["season"][index],
            metadata["target_gameweek"][index],
            metadata["player_id"][index],
        )
        values = grouped.setdefault(key, [0.0, 0.0, 0.0])
        values[0] += float(actual[index])
        values[1] += float(predicted[index])
        values[2] += float(activity[index])
    keys = list(grouped)
    group_actual = np.asarray([grouped[key][0] for key in keys], dtype=np.float64)
    group_predicted = np.asarray([grouped[key][1] for key in keys], dtype=np.float64)
    group_activity = np.asarray([grouped[key][2] for key in keys], dtype=np.float64)
    group_seasons = [key[0] for key in keys]
    group_gameweeks = [key[1] for key in keys]
    group_metrics = _regression_metrics(group_actual, group_predicted, np)
    group_metrics["mean_gameweek_spearman"] = _mean_gameweek_spearman(
        group_seasons, group_gameweeks, group_actual, group_predicted, np
    )
    group_active = group_activity > 0.0
    active_group_metrics = _regression_metrics(
        group_actual[group_active], group_predicted[group_active], np
    )
    active_group_metrics["mean_gameweek_spearman"] = _mean_gameweek_spearman(
        [value for value, keep in zip(group_seasons, group_active) if keep],
        [value for value, keep in zip(group_gameweeks, group_active) if keep],
        group_actual[group_active],
        group_predicted[group_active],
        np,
    )
    return {
        "fixture_level": fixture_metrics,
        "active_fixture_level": active_metrics,
        "player_gameweek_level": group_metrics,
        "active_player_gameweek_level": active_group_metrics,
    }


def _binary_metrics(actual: Any, probability: Any, np: Any) -> dict[str, Any]:
    return {
        "rows": int(len(actual)),
        "brier_score": float(np.mean((probability - actual) ** 2)),
        "actual_rate": float(np.mean(actual)),
        "mean_probability": float(np.mean(probability)),
        "probability_bias": float(np.mean(probability - actual)),
    }


def _take_metadata(metadata: dict[str, list[Any]], indices: Any) -> dict[str, list[Any]]:
    return {
        name: [values[int(index)] for index in indices]
        for name, values in metadata.items()
    }


def _season_metrics(
    metadata: dict[str, list[Any]],
    appearance: Any,
    start: Any,
    minutes: Any,
    points: Any,
    bundle: dict[str, Any],
    expected_points: Any,
    position_price_baseline: Any,
    rolling_baseline: Any,
    np: Any,
) -> dict[str, Any]:
    return {
        "rows": int(len(points)),
        "appearance": _binary_metrics(
            appearance, bundle["appearance_probability"], np
        ),
        "start": _binary_metrics(start, bundle["start_probability"], np),
        "minutes": _hierarchical_metrics(
            metadata, minutes, bundle["expected_minutes"], appearance, np
        ),
        "points": {
            "blended": _hierarchical_metrics(
                metadata, points, expected_points, appearance, np
            ),
            "direct": _hierarchical_metrics(
                metadata, points, bundle["direct_points"], appearance, np
            ),
            "appearance_times_conditional": _hierarchical_metrics(
                metadata,
                points,
                bundle["appearance_times_conditional_points"],
                appearance,
                np,
            ),
            "baseline_position_price": _hierarchical_metrics(
                metadata, points, position_price_baseline, appearance, np
            ),
            "baseline_rolling_shrunk_points": _hierarchical_metrics(
                metadata, points, rolling_baseline, appearance, np
            ),
        },
    }


def _write_predictions(
    path: Path,
    rows: Sequence[
        tuple[
            dict[str, list[Any]],
            Any,
            Any,
            Any,
            Any,
            dict[str, Any],
            Any,
            Any,
            Any,
        ]
    ],
) -> None:
    header = METADATA_FIELDS + (
        "expected_points",
        "appearance_probability",
        "start_probability",
        "expected_minutes",
        "actual_total_points",
        "actual_minutes",
        "actual_appearance",
        "actual_start",
        "direct_expected_points",
        "appearance_times_conditional_points",
        "baseline_position_price",
        "baseline_rolling_shrunk_points",
    )
    temporary = path.with_suffix(path.suffix + ".tmp")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with temporary.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, lineterminator="\n")
            writer.writerow(header)
            for (
                metadata,
                appearance,
                start,
                minutes,
                points,
                bundle,
                expected_points,
                position_price,
                rolling,
            ) in rows:
                for index in range(len(points)):
                    writer.writerow(
                        tuple(metadata[name][index] for name in METADATA_FIELDS)
                        + (
                            _format_float(float(expected_points[index])),
                            _format_float(float(bundle["appearance_probability"][index])),
                            _format_float(float(bundle["start_probability"][index])),
                            _format_float(float(bundle["expected_minutes"][index])),
                            _format_float(float(points[index])),
                            _format_float(float(minutes[index])),
                            int(appearance[index]),
                            int(start[index]),
                            _format_float(float(bundle["direct_points"][index])),
                            _format_float(
                                float(bundle["appearance_times_conditional_points"][index])
                            ),
                            _format_float(float(position_price[index])),
                            _format_float(float(rolling[index])),
                        )
                    )
        temporary.replace(path)
    finally:
        if temporary.exists():
            temporary.unlink()


def train_models(
    dataset_path: Path,
    model_dir: Path,
    predictions_path: Path,
    seed: int,
    overwrite: bool,
) -> dict[str, Any]:
    _validate_feature_contract()
    np, GradientBoostingClassifier, GradientBoostingRegressor = _require_ml_dependencies()
    manifest_path = dataset_path.parent / "manifest.json"
    artifact_path = model_dir / "model.json"
    metrics_path = model_dir / "metrics.json"
    validation_predictions_path = predictions_path.with_name("validation-predictions.csv")
    diagnostic_predictions_path = predictions_path.with_name(
        "diagnostic-test-predictions.csv"
    )
    _check_outputs(
        (
            artifact_path,
            metrics_path,
            predictions_path,
            validation_predictions_path,
            diagnostic_predictions_path,
        ),
        overwrite,
    )
    data, manifest = _load_dataset(dataset_path, manifest_path, np)
    season_values = np.asarray(data.metadata["season"], dtype=object)
    split_indices = {
        season: np.flatnonzero(season_values == season) for season in SEASONS
    }
    for season, indices in split_indices.items():
        if len(indices) == 0:
            raise PipelineError(f"dataset has no rows for required season {season}")

    train_indices = np.concatenate(
        [split_indices[season] for season in TRAIN_SEASONS]
    )
    validation_indices = split_indices[VALIDATION_SEASON]
    X_train = data.X[train_indices]
    y_appearance_train = data.appearance[train_indices]
    y_start_train = data.start[train_indices]
    y_minutes_train = data.minutes[train_indices]
    y_points_train = data.points[train_indices]
    if set(np.unique(y_appearance_train)) != {0.0, 1.0}:
        raise PipelineError("training appearance target must contain both binary classes")
    if set(np.unique(y_start_train)) != {0.0, 1.0}:
        raise PipelineError("training start target must contain both binary classes")
    active_train = y_appearance_train > 0.0

    classifier_params = dict(GB_CLASSIFIER_PARAMS, random_state=seed)
    regressor_params = dict(GB_REGRESSOR_PARAMS, random_state=seed)
    models = {
        "appearance_classifier": GradientBoostingClassifier(**classifier_params),
        "start_classifier": GradientBoostingClassifier(**classifier_params),
        "conditional_minutes_regressor": GradientBoostingRegressor(**regressor_params),
        "conditional_points_regressor": GradientBoostingRegressor(**regressor_params),
        "direct_points_regressor": GradientBoostingRegressor(**regressor_params),
    }
    models["appearance_classifier"].fit(X_train, y_appearance_train)
    models["start_classifier"].fit(X_train, y_start_train)
    models["conditional_minutes_regressor"].fit(
        X_train[active_train], y_minutes_train[active_train]
    )
    models["conditional_points_regressor"].fit(
        X_train[active_train], y_points_train[active_train]
    )
    models["direct_points_regressor"].fit(X_train, y_points_train)

    train_positions = [data.metadata["position"][int(i)] for i in train_indices]
    price_index = FEATURE_NAMES.index("known_price_m")
    position_price_baseline = _fit_position_price_baseline(
        train_positions, X_train[:, price_index], y_points_train
    )
    rolling_points_index = FEATURE_NAMES.index("history_points_per90_std")
    rolling_minutes_index = FEATURE_NAMES.index("history_minutes_per_match_std")

    # Only validation outcomes participate in blend selection.
    X_validation = data.X[validation_indices]
    validation_bundle = _predict_models(models, X_validation, np)
    validation_metadata = _take_metadata(data.metadata, validation_indices)
    validation_candidates = []
    for direct_weight in BLEND_CANDIDATES:
        candidate = (
            direct_weight * validation_bundle["direct_points"]
            + (1.0 - direct_weight)
            * validation_bundle["appearance_times_conditional_points"]
        )
        candidate_metrics = _regression_metrics(
            data.points[validation_indices], candidate, np
        )
        hierarchical = _hierarchical_metrics(
            validation_metadata,
            data.points[validation_indices],
            candidate,
            data.appearance[validation_indices],
            np,
        )
        active_player_gameweek = hierarchical["active_player_gameweek_level"]
        validation_candidates.append(
            {
                "direct_weight": direct_weight,
                "conditional_weight": 1.0 - direct_weight,
                "fixture_mae": candidate_metrics["mae"],
                "fixture_rmse": candidate_metrics["rmse"],
                "active_player_gameweek_mae": active_player_gameweek["mae"],
                "active_player_gameweek_rmse": active_player_gameweek["rmse"],
                "active_player_gameweek_mean_spearman": active_player_gameweek[
                    "mean_gameweek_spearman"
                ],
            }
        )
    selected = min(
        validation_candidates,
        key=lambda item: (
            item["active_player_gameweek_rmse"],
            item["active_player_gameweek_mae"],
            -(item["active_player_gameweek_mean_spearman"] or -1.0),
            item["direct_weight"],
        ),
    )
    direct_weight = float(selected["direct_weight"])
    conditional_weight = 1.0 - direct_weight
    validation_expected_points = (
        direct_weight * validation_bundle["direct_points"]
        + conditional_weight
        * validation_bundle["appearance_times_conditional_points"]
    )

    validation_position_price = _predict_position_price_baseline(
        position_price_baseline,
        validation_metadata["position"],
        X_validation[:, price_index],
        np,
    )
    validation_rolling = (
        X_validation[:, rolling_points_index]
        * X_validation[:, rolling_minutes_index]
        / 90.0
    )
    validation_metrics = _season_metrics(
        validation_metadata,
        data.appearance[validation_indices],
        data.start[validation_indices],
        data.minutes[validation_indices],
        data.points[validation_indices],
        validation_bundle,
        validation_expected_points,
        validation_position_price,
        validation_rolling,
        np,
    )

    # The test season is first predicted and scored after the blend is frozen.
    test_indices = split_indices[TEST_SEASON]
    X_test = data.X[test_indices]
    test_bundle = _predict_models(models, X_test, np)
    test_expected_points = (
        direct_weight * test_bundle["direct_points"]
        + conditional_weight * test_bundle["appearance_times_conditional_points"]
    )
    test_metadata = _take_metadata(data.metadata, test_indices)
    test_position_price = _predict_position_price_baseline(
        position_price_baseline,
        test_metadata["position"],
        X_test[:, price_index],
        np,
    )
    test_rolling = (
        X_test[:, rolling_points_index] * X_test[:, rolling_minutes_index] / 90.0
    )
    test_metrics = _season_metrics(
        test_metadata,
        data.appearance[test_indices],
        data.start[test_indices],
        data.minutes[test_indices],
        data.points[test_indices],
        test_bundle,
        test_expected_points,
        test_position_price,
        test_rolling,
        np,
    )

    serialized_models = {
        name: _serialize_gradient_boosting(
            model,
            "binary_classification" if "classifier" in name else "regression",
            len(FEATURE_NAMES),
            np,
        )
        for name, model in models.items()
    }
    serialized_round_trip = json.loads(
        json.dumps(serialized_models, ensure_ascii=True, allow_nan=False)
    )
    self_check = _self_check_models(models, serialized_round_trip, data.X, np)

    cutoffs = {
        season: max(
            data.metadata["kickoff_time"][int(index)]
            for index in split_indices[season]
        )
        for season in SEASONS
    }
    metrics = {
        "definitions": {
            "bias": "mean(prediction - actual)",
            "active": "actual minutes > 0; diagnostic subset only",
            "fixture_level": "one canonical player-fixture target row",
            "player_gameweek_level": "sum over a player's fixtures in the target gameweek",
        },
        "protocol": {
            "train_seasons": list(TRAIN_SEASONS),
            "validation_season": VALIDATION_SEASON,
            "test_season": TEST_SEASON,
            "test_used_for_selection": False,
            "promotion_test": False,
        },
        "blend_selection": {
            "criterion": (
                "validation active player-gameweek RMSE, then MAE and mean gameweek "
                "Spearman; activity is a validation target only"
            ),
            "candidates": validation_candidates,
            "selected": selected,
        },
        "validation": {"season": VALIDATION_SEASON, **validation_metrics},
        "test": {"season": TEST_SEASON, **test_metrics},
    }
    limitations = [
        "Historical GW files are reconstructed post-event exports, not strict deadline snapshots.",
        "The model intentionally omits live availability, injury, ownership, and transfer signals.",
        "Current price is used only for a season cold start; later rows use the last prior-GW price.",
        "Defensive-contribution history is unavailable before 2025-2026 and is flagged explicitly.",
        "The defensive-scoring flag is unseen during 2022-2024 fitting, so its test-era effect cannot be learned.",
        "Seasons before 2022-2023 are excluded from this advanced model because the source files omit starts and expected-goal fields; they require a separate common-schema model.",
        "Element IDs are season-local metadata, so cross-season player continuity is not modeled.",
        "Validation and test features update online from earlier completed GWs in the same season.",
    ]
    artifact = {
        "model_version": MODEL_VERSION,
        "data_version": DATA_VERSION,
        "schema_version": SCHEMA_VERSION,
        "created_at_utc": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "reconstructed_not_strict": True,
        "feature_names": list(FEATURE_NAMES),
        "feature_count": len(FEATURE_NAMES),
        "metadata_fields": list(METADATA_FIELDS),
        "target_fields": list(TARGET_FIELDS),
        "identity_fields_excluded": list(IDENTITY_FIELDS_EXCLUDED),
        "training_protocol": metrics["protocol"],
        "training_cutoffs": {
            "latest_kickoff_by_season": cutoffs,
            "model_fit_through": max(cutoffs[season] for season in TRAIN_SEASONS),
            "blend_selected_through": cutoffs[VALIDATION_SEASON],
            "test_scored_through": cutoffs[TEST_SEASON],
        },
        "hyperparameters": {
            "seed": seed,
            "classifier": classifier_params,
            "regressor": regressor_params,
            "blend_candidates": list(BLEND_CANDIDATES),
        },
        "models": serialized_round_trip,
        "inference": {
            "tree_rule": "Go left when feature_value <= threshold; otherwise go right.",
            "raw_score": "base_score + learning_rate * sum(tree_leaf_value)",
            "binary_link": "sigmoid(raw_score)",
            "appearance_probability_model": "appearance_classifier",
            "start_probability": "min(sigmoid(start_classifier), appearance_probability)",
            "expected_minutes": "appearance_probability * clip(conditional_minutes, 1, 90)",
            "conditional_expected_points": (
                "appearance_probability * conditional_points_regressor"
            ),
            "expected_points": (
                "direct_weight * direct_points_regressor + conditional_weight * "
                "conditional_expected_points"
            ),
        },
        "blend_weights": {
            "direct_weight": direct_weight,
            "conditional_weight": conditional_weight,
            "selected_on": VALIDATION_SEASON,
        },
        "baselines": {
            "position_price": position_price_baseline,
            "rolling_shrunk_points": {
                "formula": (
                    "history_points_per90_std * history_minutes_per_match_std / 90"
                )
            },
        },
        "metrics": metrics,
        "self_check": self_check,
        "known_limitations": limitations,
        "dataset_manifest_summary": {
            "row_count": manifest["row_count"],
            "season_stats": manifest["season_stats"],
        },
    }

    model_dir.mkdir(parents=True, exist_ok=True)
    _write_json(artifact_path, artifact)
    with artifact_path.open("r", encoding="utf-8") as handle:
        written_artifact = json.load(handle)
    _self_check_models(models, written_artifact["models"], data.X, np)
    _write_json(metrics_path, metrics)
    validation_prediction_bundle = (
        validation_metadata,
        data.appearance[validation_indices],
        data.start[validation_indices],
        data.minutes[validation_indices],
        data.points[validation_indices],
        validation_bundle,
        validation_expected_points,
        validation_position_price,
        validation_rolling,
    )
    diagnostic_prediction_bundle = (
        test_metadata,
        data.appearance[test_indices],
        data.start[test_indices],
        data.minutes[test_indices],
        data.points[test_indices],
        test_bundle,
        test_expected_points,
        test_position_price,
        test_rolling,
    )
    _write_predictions(
        predictions_path,
        (validation_prediction_bundle, diagnostic_prediction_bundle),
    )
    _write_predictions(validation_predictions_path, (validation_prediction_bundle,))
    _write_predictions(diagnostic_predictions_path, (diagnostic_prediction_bundle,))
    validation_mae = metrics["validation"]["points"]["blended"]["fixture_level"]["mae"]
    test_mae = metrics["test"]["points"]["blended"]["fixture_level"]["mae"]
    print(f"wrote portable model {artifact_path}")
    print(f"wrote out-of-season predictions {predictions_path}")
    print(f"wrote validation-only predictions {validation_predictions_path}")
    print(f"wrote diagnostic-test predictions {diagnostic_predictions_path}")
    print(
        f"blend direct={direct_weight:.2f}, conditional={conditional_weight:.2f}; "
        f"validation MAE={validation_mae:.4f}; test MAE={test_mae:.4f}"
    )
    return artifact


def _add_build_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--historical-dir",
        type=Path,
        default=DEFAULT_HISTORICAL_DIR,
        help=f"historical season root (default: {DEFAULT_HISTORICAL_DIR})",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_DATASET_DIR,
        help=f"dataset output directory (default: {DEFAULT_DATASET_DIR})",
    )
    parser.add_argument(
        "--overwrite", action="store_true", help="replace existing generated outputs"
    )


def _add_train_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--dataset",
        type=Path,
        default=DEFAULT_DATASET_DIR / "dataset.csv",
        help=f"built dataset CSV (default: {DEFAULT_DATASET_DIR / 'dataset.csv'})",
    )
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=DEFAULT_MODEL_DIR,
        help=f"model artifact output directory (default: {DEFAULT_MODEL_DIR})",
    )
    parser.add_argument(
        "--predictions",
        type=Path,
        default=DEFAULT_DATASET_DIR / "out-of-season-predictions.csv",
        help="validation/test prediction CSV path",
    )
    parser.add_argument("--seed", type=int, default=SEED, help=f"random seed (default: {SEED})")
    parser.add_argument(
        "--overwrite", action="store_true", help="replace existing generated outputs"
    )


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Build and train the local leakage-safe FPL player-fixture ML pipeline. "
            "Training dependencies are imported only by train/all."
        )
    )
    parser.add_argument("--version", action="version", version=MODEL_VERSION)
    subparsers = parser.add_subparsers(dest="command", required=True)
    build_parser = subparsers.add_parser(
        "build", help="build the prior-GW feature dataset"
    )
    _add_build_arguments(build_parser)
    train_parser = subparsers.add_parser(
        "train", help="fit, validate, test, and export portable JSON"
    )
    _add_train_arguments(train_parser)
    all_parser = subparsers.add_parser("all", help="build and then train")
    all_parser.add_argument(
        "--historical-dir",
        type=Path,
        default=DEFAULT_HISTORICAL_DIR,
        help=f"historical season root (default: {DEFAULT_HISTORICAL_DIR})",
    )
    all_parser.add_argument(
        "--dataset-dir",
        type=Path,
        default=DEFAULT_DATASET_DIR,
        help=f"dataset output directory (default: {DEFAULT_DATASET_DIR})",
    )
    all_parser.add_argument(
        "--model-dir",
        type=Path,
        default=DEFAULT_MODEL_DIR,
        help=f"model artifact output directory (default: {DEFAULT_MODEL_DIR})",
    )
    all_parser.add_argument("--seed", type=int, default=SEED, help=f"random seed (default: {SEED})")
    all_parser.add_argument(
        "--overwrite", action="store_true", help="replace existing generated outputs"
    )
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = create_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            build_dataset(args.historical_dir, args.output_dir, args.overwrite)
        elif args.command == "train":
            train_models(
                args.dataset,
                args.model_dir,
                args.predictions,
                args.seed,
                args.overwrite,
            )
        elif args.command == "all":
            build_dataset(args.historical_dir, args.dataset_dir, args.overwrite)
            train_models(
                args.dataset_dir / "dataset.csv",
                args.model_dir,
                args.dataset_dir / "out-of-season-predictions.csv",
                args.seed,
                args.overwrite,
            )
        else:
            parser.error(f"unknown command {args.command}")
    except PipelineError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
