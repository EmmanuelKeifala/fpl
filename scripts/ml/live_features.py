#!/usr/bin/env python3
"""Generate deadline-safe live player-fixture feature vectors from public FPL data."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.ml.pipeline import (
    FEATURE_NAMES,
    MODEL_VERSION,
    SCHEMA_VERSION,
    PipelineError,
    PlayerEvent,
    PlayerState,
    TargetFixtureContext,
    TeamEvent,
    _iso_z,
    _parse_datetime,
    _write_json,
    build_canonical_feature_vector,
)


API_BASE = "https://fantasy.premierleague.com/api"
LIVE_DATA_VERSION = "fpl-api-element-history-v1"
FEATURE_BUILDER_VERSION = "python-player-fixture-builder-v1"
POSITION_BY_ELEMENT_TYPE = {1: "GK", 2: "DEF", 3: "MID", 4: "FWD"}


@dataclass(frozen=True)
class FetchedJson:
    value: Any
    raw: bytes
    fetched_at: datetime

    @property
    def sha256(self) -> str:
        return hashlib.sha256(self.raw).hexdigest()


def _finite(value: Any, label: str) -> float:
    if value is None or value == "":
        raise PipelineError(f"missing numeric {label}")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise PipelineError(f"invalid numeric {label}={value!r}") from exc
    if not math.isfinite(result):
        raise PipelineError(f"non-finite numeric {label}={value!r}")
    return result


def _integer(value: Any, label: str) -> int:
    result = _finite(value, label)
    if not result.is_integer():
        raise PipelineError(f"invalid integer {label}={value!r}")
    return int(result)


def _timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        raise PipelineError(f"missing timestamp {label}")
    return _parse_datetime(value, Path(label), 1)


def _mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise PipelineError(f"{label} must be an object")
    return value


def _sequence(value: Any, label: str) -> Sequence[Any]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes, bytearray)):
        raise PipelineError(f"{label} must be an array")
    return value


def _canonical_payload_hash(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def derive_season(events: Sequence[Any]) -> str:
    deadlines = [
        _timestamp(_mapping(event, "event").get("deadline_time"), "deadline_time")
        for event in events
    ]
    if not deadlines:
        raise PipelineError("bootstrap contains no gameweek deadlines")
    start_year = min(deadlines).year
    return f"{start_year}-{start_year + 1}"


def select_target_gameweek(
    bootstrap: Mapping[str, Any], requested: int | None, now: datetime
) -> int:
    events = [_mapping(event, "event") for event in _sequence(bootstrap.get("events"), "events")]
    if requested is not None:
        if not any(_integer(event.get("id"), "event.id") == requested for event in events):
            raise PipelineError(f"bootstrap has no GW{requested}")
        return requested
    upcoming = [
        event
        for event in events
        if not bool(event.get("finished"))
        and _timestamp(event.get("deadline_time"), "deadline_time") > now
    ]
    if not upcoming:
        raise PipelineError("bootstrap has no future unfinished gameweek; pass --gameweek only for an offline capture")
    return min(_integer(event.get("id"), "event.id") for event in upcoming)


def _build_player_states(
    players: Sequence[Mapping[str, Any]],
    summaries: Mapping[int, Mapping[str, Any]],
    fixtures_by_id: Mapping[int, Mapping[str, Any]],
    target_gameweek: int,
) -> tuple[dict[int, PlayerState], int]:
    states: dict[int, PlayerState] = {}
    latest_included = 0
    for player in players:
        player_id = _integer(player.get("id"), "player.id")
        summary = summaries.get(player_id)
        if summary is None:
            if target_gameweek > 1:
                raise PipelineError(f"missing element summary for player {player_id}")
            states[player_id] = PlayerState()
            continue
        history = _sequence(summary.get("history"), f"player {player_id} history")
        seen_fixtures: set[int] = set()
        priced_events: list[tuple[int, datetime, float]] = []
        state = PlayerState()
        for item in history:
            row = _mapping(item, f"player {player_id} history row")
            gameweek = _integer(row.get("round"), f"player {player_id} round")
            if gameweek >= target_gameweek:
                continue
            fixture_id = _integer(row.get("fixture"), f"player {player_id} fixture")
            if fixture_id in seen_fixtures:
                raise PipelineError(f"duplicate history fixture {fixture_id} for player {player_id}")
            seen_fixtures.add(fixture_id)
            fixture = fixtures_by_id.get(fixture_id)
            kickoff_raw = row.get("kickoff_time") or (fixture.get("kickoff_time") if fixture else None)
            kickoff = _timestamp(kickoff_raw, f"player {player_id} fixture {fixture_id} kickoff")
            starts = _finite(row.get("starts"), f"player {player_id} fixture {fixture_id} starts")
            minutes = _finite(row.get("minutes"), f"player {player_id} fixture {fixture_id} minutes")
            defensive = None
            if "defensive_contribution" in row and row.get("defensive_contribution") not in (None, ""):
                defensive = _finite(
                    row.get("defensive_contribution"),
                    f"player {player_id} fixture {fixture_id} defensive_contribution",
                )
            state.events.append(
                PlayerEvent(
                    gameweek=gameweek,
                    kickoff=kickoff,
                    minutes=minutes,
                    appearance=float(minutes > 0.0),
                    start=float(starts > 0.0),
                    total_points=_finite(row.get("total_points"), f"player {player_id} fixture {fixture_id} total_points"),
                    expected_goals=_finite(row.get("expected_goals"), f"player {player_id} fixture {fixture_id} expected_goals"),
                    expected_assists=_finite(row.get("expected_assists"), f"player {player_id} fixture {fixture_id} expected_assists"),
                    expected_goals_conceded=_finite(
                        row.get("expected_goals_conceded"),
                        f"player {player_id} fixture {fixture_id} expected_goals_conceded",
                    ),
                    clean_sheets=_finite(row.get("clean_sheets"), f"player {player_id} fixture {fixture_id} clean_sheets"),
                    saves=_finite(row.get("saves"), f"player {player_id} fixture {fixture_id} saves"),
                    bonus=_finite(row.get("bonus"), f"player {player_id} fixture {fixture_id} bonus"),
                    goals=_finite(row.get("goals_scored"), f"player {player_id} fixture {fixture_id} goals_scored"),
                    assists=_finite(row.get("assists"), f"player {player_id} fixture {fixture_id} assists"),
                    cards=(
                        _finite(row.get("yellow_cards"), f"player {player_id} fixture {fixture_id} yellow_cards")
                        + _finite(row.get("red_cards"), f"player {player_id} fixture {fixture_id} red_cards")
                    ),
                    defensive_contribution=defensive,
                )
            )
            priced_events.append(
                (
                    gameweek,
                    kickoff,
                    _finite(row.get("value"), f"player {player_id} fixture {fixture_id} value") / 10.0,
                )
            )
            latest_included = max(latest_included, gameweek)
        state.events.sort(key=lambda event: (event.gameweek, event.kickoff))
        if priced_events:
            state.last_price_m = max(priced_events, key=lambda value: (value[0], value[1]))[2]
        states[player_id] = state
    return states, latest_included


def _build_team_states(
    fixtures: Sequence[Mapping[str, Any]], target_gameweek: int
) -> dict[int, list[TeamEvent]]:
    states: dict[int, list[TeamEvent]] = {}
    seen: set[int] = set()
    for fixture in fixtures:
        event_raw = fixture.get("event")
        if event_raw is None:
            continue
        gameweek = _integer(event_raw, "fixture.event")
        if gameweek >= target_gameweek or not bool(fixture.get("finished")):
            continue
        fixture_id = _integer(fixture.get("id"), "fixture.id")
        if fixture_id in seen:
            raise PipelineError(f"duplicate fixture {fixture_id}")
        seen.add(fixture_id)
        home_score = _finite(fixture.get("team_h_score"), f"fixture {fixture_id} team_h_score")
        away_score = _finite(fixture.get("team_a_score"), f"fixture {fixture_id} team_a_score")
        kickoff = _timestamp(fixture.get("kickoff_time"), f"fixture {fixture_id} kickoff")
        home = _integer(fixture.get("team_h"), f"fixture {fixture_id} team_h")
        away = _integer(fixture.get("team_a"), f"fixture {fixture_id} team_a")
        states.setdefault(home, []).append(TeamEvent(gameweek, kickoff, home_score, away_score))
        states.setdefault(away, []).append(TeamEvent(gameweek, kickoff, away_score, home_score))
    for events in states.values():
        events.sort(key=lambda event: (event.gameweek, event.kickoff))
    return states


def generate_live_feature_sidecar(
    bootstrap_value: Any,
    fixtures_value: Any,
    element_summaries: Mapping[int, Any],
    *,
    season: str,
    target_gameweek: int,
    as_of: datetime,
    generated_at: datetime | None = None,
    scoring_defensive_contributions: bool,
    source_hashes: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    bootstrap = _mapping(bootstrap_value, "bootstrap")
    fixtures = [_mapping(value, "fixture") for value in _sequence(fixtures_value, "fixtures")]
    events = [_mapping(value, "event") for value in _sequence(bootstrap.get("events"), "events")]
    event = next(
        (candidate for candidate in events if _integer(candidate.get("id"), "event.id") == target_gameweek),
        None,
    )
    if event is None:
        raise PipelineError(f"bootstrap has no target GW{target_gameweek}")
    if target_gameweek > 1:
        previous = next(
            (
                candidate
                for candidate in events
                if _integer(candidate.get("id"), "event.id") == target_gameweek - 1
            ),
            None,
        )
        if previous is None or not bool(previous.get("finished")) or not bool(previous.get("data_checked")):
            raise PipelineError(
                f"GW{target_gameweek - 1} must be finished and data-checked before building GW{target_gameweek}"
            )
    deadline = _timestamp(event.get("deadline_time"), "target deadline")
    as_of = as_of.astimezone(timezone.utc)
    generated_at = (generated_at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    if as_of > deadline:
        raise PipelineError(f"source capture {_iso_z(as_of)} is after GW{target_gameweek} deadline {_iso_z(deadline)}")
    if season != derive_season(events):
        raise PipelineError(f"season {season} does not match bootstrap deadlines ({derive_season(events)})")

    target_fixtures = [
        fixture
        for fixture in fixtures
        if fixture.get("event") is not None
        and _integer(fixture.get("event"), "fixture.event") == target_gameweek
    ]
    if not target_fixtures:
        raise PipelineError(f"fixtures contain no rows for target GW{target_gameweek}")
    for fixture in target_fixtures:
        _timestamp(fixture.get("kickoff_time"), f"fixture {fixture.get('id')} kickoff")

    target_team_ids = {
        team_id
        for fixture in target_fixtures
        for team_id in (
            _integer(fixture.get("team_h"), "fixture.team_h"),
            _integer(fixture.get("team_a"), "fixture.team_a"),
        )
    }
    players = [
        _mapping(value, "player")
        for value in _sequence(bootstrap.get("elements"), "elements")
        if _integer(_mapping(value, "player").get("team"), "player.team") in target_team_ids
        and _integer(_mapping(value, "player").get("element_type"), "player.element_type") in POSITION_BY_ELEMENT_TYPE
    ]
    summaries = {player_id: _mapping(value, f"element summary {player_id}") for player_id, value in element_summaries.items()}
    fixtures_by_id = {
        _integer(fixture.get("id"), "fixture.id"): fixture for fixture in fixtures
    }
    player_states, latest_included = _build_player_states(
        players, summaries, fixtures_by_id, target_gameweek
    )
    if latest_included != target_gameweek - 1:
        raise PipelineError(
            f"latest player history is GW{latest_included}; expected GW{target_gameweek - 1}"
        )
    team_states = _build_team_states(fixtures, target_gameweek)
    target_by_team: dict[int, list[Mapping[str, Any]]] = {}
    for fixture in target_fixtures:
        target_by_team.setdefault(_integer(fixture.get("team_h"), "fixture.team_h"), []).append(fixture)
        target_by_team.setdefault(_integer(fixture.get("team_a"), "fixture.team_a"), []).append(fixture)
    target_kickoffs_by_team = {
        team_id: [
            _timestamp(fixture.get("kickoff_time"), f"fixture {fixture.get('id')} kickoff")
            for fixture in team_fixtures
        ]
        for team_id, team_fixtures in target_by_team.items()
    }

    teams_by_id = {
        _integer(_mapping(value, "team").get("id"), "team.id"): _mapping(value, "team")
        for value in _sequence(bootstrap.get("teams"), "teams")
    }
    rows: list[dict[str, Any]] = []
    seen_rows: set[tuple[int, int]] = set()
    for player in players:
        player_id = _integer(player.get("id"), "player.id")
        team_id = _integer(player.get("team"), f"player {player_id} team")
        position = POSITION_BY_ELEMENT_TYPE[_integer(player.get("element_type"), f"player {player_id} element_type")]
        player_name = str(player.get("web_name") or player_id)
        team_name = str(teams_by_id.get(team_id, {}).get("name") or team_id)
        club_fixtures = target_by_team.get(team_id, [])
        for fixture in club_fixtures:
            fixture_id = _integer(fixture.get("id"), "fixture.id")
            key = (fixture_id, player_id)
            if key in seen_rows:
                raise PipelineError(f"duplicate target row fixture {fixture_id} player {player_id}")
            seen_rows.add(key)
            home_id = _integer(fixture.get("team_h"), f"fixture {fixture_id} team_h")
            away_id = _integer(fixture.get("team_a"), f"fixture {fixture_id} team_a")
            was_home = home_id == team_id
            opponent_id = away_id if was_home else home_id
            kickoff = _timestamp(fixture.get("kickoff_time"), f"fixture {fixture_id} kickoff")
            context = TargetFixtureContext(
                season=season,
                gameweek=target_gameweek,
                fixture_id=fixture_id,
                player_id=player_id,
                player_name=player_name,
                position=position,
                team_id=team_id,
                team_name=team_name,
                opponent_id=opponent_id,
                kickoff=kickoff,
                was_home=was_home,
                price_m=_finite(player.get("now_cost"), f"player {player_id} now_cost") / 10.0,
            )
            vector = build_canonical_feature_vector(
                context,
                player_states,
                team_states,
                len({
                    _integer(item.get("id"), "fixture.id") for item in club_fixtures
                }),
                scoring_defensive_contributions=scoring_defensive_contributions,
                target_gameweek_kickoffs=target_kickoffs_by_team,
            )
            rows.append(
                {
                    "fixture_id": fixture_id,
                    "player_id": player_id,
                    "team_id": team_id,
                    "opponent_id": opponent_id,
                    "position": position,
                    "kickoff_time": _iso_z(kickoff),
                    "features": vector,
                }
            )
    rows.sort(key=lambda row: (row["fixture_id"], row["player_id"]))

    schedule = [
        {
            "id": _integer(fixture.get("id"), "fixture.id"),
            "event": target_gameweek,
            "kickoff_time": fixture.get("kickoff_time"),
            "team_h": _integer(fixture.get("team_h"), "fixture.team_h"),
            "team_a": _integer(fixture.get("team_a"), "fixture.team_a"),
        }
        for fixture in sorted(target_fixtures, key=lambda value: _integer(value.get("id"), "fixture.id"))
    ]
    hashes = dict(source_hashes or {})
    hashes.setdefault("bootstrap_static", _canonical_payload_hash(bootstrap_value))
    hashes.setdefault("fixtures", _canonical_payload_hash(fixtures_value))
    hashes.setdefault("element_summaries", _canonical_payload_hash(element_summaries))
    return {
        "artifact_type": "player-fixture-live-features",
        "model_version": MODEL_VERSION,
        "feature_schema_version": SCHEMA_VERSION,
        "feature_builder_version": FEATURE_BUILDER_VERSION,
        "live_data_version": LIVE_DATA_VERSION,
        "season": season,
        "target_gameweek": target_gameweek,
        "generated_at_utc": _iso_z(generated_at),
        "as_of_utc": _iso_z(as_of),
        "deadline_utc": _iso_z(deadline),
        "scoring_defensive_contributions": scoring_defensive_contributions,
        "numeric_encoding": "float64-rounded-10-significant-digits",
        "feature_count": len(FEATURE_NAMES),
        "feature_names": list(FEATURE_NAMES),
        "latest_included_gameweek": latest_included,
        "target_fixtures": schedule,
        "fixture_schedule_sha256": _canonical_payload_hash(schedule),
        "source_hashes": hashes,
        "rows": rows,
    }


def _fetch_json(url: str, attempts: int = 3) -> FetchedJson:
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(
            url,
            headers={"User-Agent": "fpl-agent-ml-shadow/1.0", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
            return FetchedJson(json.loads(raw), raw, datetime.now(timezone.utc))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            if attempt == attempts:
                raise PipelineError(f"failed to fetch {url}: {exc}") from exc
            time.sleep(0.5 * attempt)
    raise AssertionError("unreachable")


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-base", default=API_BASE)
    parser.add_argument("--season")
    parser.add_argument("--gameweek", type=int)
    parser.add_argument("--workers", type=int, default=12)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--overwrite", action="store_true")
    scoring = parser.add_mutually_exclusive_group()
    scoring.add_argument("--defensive-contributions", action="store_true", dest="defensive")
    scoring.add_argument("--no-defensive-contributions", action="store_false", dest="defensive")
    parser.set_defaults(defensive=None)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    if args.workers < 1 or args.workers > 32:
        raise PipelineError("--workers must be between 1 and 32")
    base = args.api_base.rstrip("/")
    bootstrap_fetch = _fetch_json(f"{base}/bootstrap-static/")
    fixtures_fetch = _fetch_json(f"{base}/fixtures/")
    bootstrap = _mapping(bootstrap_fetch.value, "bootstrap")
    now = max(bootstrap_fetch.fetched_at, fixtures_fetch.fetched_at)
    target_gameweek = select_target_gameweek(bootstrap, args.gameweek, now)
    season = args.season or derive_season(_sequence(bootstrap.get("events"), "events"))
    start_year = int(season.split("-", 1)[0])
    defensive = args.defensive if args.defensive is not None else start_year >= 2025

    fixtures = [_mapping(value, "fixture") for value in _sequence(fixtures_fetch.value, "fixtures")]
    target_teams = {
        team
        for fixture in fixtures
        if fixture.get("event") is not None
        and _integer(fixture.get("event"), "fixture.event") == target_gameweek
        for team in (
            _integer(fixture.get("team_h"), "fixture.team_h"),
            _integer(fixture.get("team_a"), "fixture.team_a"),
        )
    }
    target_player_ids = sorted(
        _integer(_mapping(value, "player").get("id"), "player.id")
        for value in _sequence(bootstrap.get("elements"), "elements")
        if _integer(_mapping(value, "player").get("team"), "player.team") in target_teams
        and _integer(_mapping(value, "player").get("element_type"), "player.element_type") in POSITION_BY_ELEMENT_TYPE
    )
    summaries: dict[int, Any] = {}
    summary_hash = hashlib.sha256()
    fetched_times = [bootstrap_fetch.fetched_at, fixtures_fetch.fetched_at]
    if target_gameweek > 1:
        with ThreadPoolExecutor(max_workers=args.workers) as executor:
            futures = {
                executor.submit(_fetch_json, f"{base}/element-summary/{player_id}/"): player_id
                for player_id in target_player_ids
            }
            fetched_by_id: dict[int, FetchedJson] = {}
            for future in as_completed(futures):
                player_id = futures[future]
                fetched_by_id[player_id] = future.result()
        for player_id in target_player_ids:
            fetched = fetched_by_id[player_id]
            summaries[player_id] = fetched.value
            fetched_times.append(fetched.fetched_at)
            summary_hash.update(f"{player_id}:".encode("ascii"))
            summary_hash.update(fetched.raw)
    as_of = max(fetched_times)
    sidecar = generate_live_feature_sidecar(
        bootstrap_fetch.value,
        fixtures_fetch.value,
        summaries,
        season=season,
        target_gameweek=target_gameweek,
        as_of=as_of,
        scoring_defensive_contributions=defensive,
        source_hashes={
            "bootstrap_static": bootstrap_fetch.sha256,
            "fixtures": fixtures_fetch.sha256,
            "element_summaries": summary_hash.hexdigest(),
        },
    )
    output = args.output or (
        Path("data")
        / "live"
        / SCHEMA_VERSION
        / season
        / f"gw-{target_gameweek:02d}"
        / f"features-{as_of.strftime('%Y%m%dT%H%M%SZ')}.json"
    )
    if output.exists() and not args.overwrite:
        raise PipelineError(f"output already exists: {output}; pass --overwrite to replace it")
    _write_json(output, sidecar)
    print(f"wrote {len(sidecar['rows'])} player-fixture vectors to {output}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PipelineError as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2)
