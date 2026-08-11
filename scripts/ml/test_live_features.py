"""Dependency-free tests for public live feature sidecars."""

from __future__ import annotations

import copy
import unittest
from datetime import datetime, timezone

from scripts.ml import pipeline
from scripts.ml.live_features import generate_live_feature_sidecar


def history_row(player_id: int, *, target: bool = False) -> dict[str, object]:
    return {
        "element": player_id,
        "fixture": 20 if target else 10,
        "round": 2 if target else 1,
        "kickoff_time": "2025-08-16T14:00:00Z" if target else "2025-08-09T14:00:00Z",
        "value": 55,
        "minutes": 90,
        "starts": 1,
        "total_points": 100 if target else 6,
        "expected_goals": "10" if target else "0.2",
        "expected_assists": "10" if target else "0.1",
        "expected_goals_conceded": "0" if target else "1.0",
        "clean_sheets": 1,
        "saves": 0,
        "bonus": 2,
        "goals_scored": 10 if target else 1,
        "assists": 1,
        "yellow_cards": 0,
        "red_cards": 0,
    }


def fixture_payload() -> tuple[dict[str, object], list[dict[str, object]], dict[int, object]]:
    bootstrap: dict[str, object] = {
        "events": [
            {"id": 1, "deadline_time": "2025-08-08T17:30:00Z", "finished": True, "data_checked": True},
            {"id": 2, "deadline_time": "2025-08-15T17:30:00Z", "finished": False, "data_checked": False},
        ],
        "teams": [
            {"id": 1, "name": "Alpha"},
            {"id": 2, "name": "Bravo"},
        ],
        "elements": [
            {"id": 1, "web_name": "Prior", "team": 1, "element_type": 3, "now_cost": 99, "total_points": 999},
            {"id": 2, "web_name": "Opponent", "team": 2, "element_type": 2, "now_cost": 45, "total_points": 999},
            {"id": 3, "web_name": "Cold", "team": 1, "element_type": 4, "now_cost": 70, "total_points": 999},
        ],
    }
    fixtures = [
        {
            "id": 10,
            "event": 1,
            "finished": True,
            "kickoff_time": "2025-08-09T14:00:00Z",
            "team_h": 1,
            "team_a": 2,
            "team_h_score": 2,
            "team_a_score": 1,
        },
        {
            "id": 20,
            "event": 2,
            "finished": False,
            "kickoff_time": "2025-08-16T14:00:00Z",
            "team_h": 2,
            "team_a": 1,
            "team_h_score": None,
            "team_a_score": None,
        },
    ]
    summaries = {
        1: {"history": [history_row(1), history_row(1, target=True)]},
        2: {"history": [history_row(2)]},
        3: {"history": []},
    }
    return bootstrap, fixtures, summaries


class LiveFeatureSidecarTest(unittest.TestCase):
    def build(self, bootstrap: object, fixtures: object, summaries: dict[int, object]) -> dict[str, object]:
        return generate_live_feature_sidecar(
            bootstrap,
            fixtures,
            summaries,
            season="2025-2026",
            target_gameweek=2,
            as_of=datetime(2025, 8, 15, 12, tzinfo=timezone.utc),
            generated_at=datetime(2025, 8, 15, 12, tzinfo=timezone.utc),
            scoring_defensive_contributions=True,
        )

    def test_sidecar_uses_prior_fixture_history_and_exact_feature_contract(self) -> None:
        bootstrap, fixtures, summaries = fixture_payload()
        sidecar = self.build(bootstrap, fixtures, summaries)

        self.assertEqual(sidecar["feature_names"], list(pipeline.FEATURE_NAMES))
        self.assertEqual(sidecar["feature_count"], 96)
        self.assertEqual(sidecar["latest_included_gameweek"], 1)
        self.assertEqual(len(sidecar["rows"]), 3)

        prior_row = next(row for row in sidecar["rows"] if row["player_id"] == 1)
        features = dict(zip(sidecar["feature_names"], prior_row["features"]))
        self.assertEqual(features["known_price_m"], 5.5)
        self.assertEqual(features["price_cold_start"], 0.0)
        self.assertEqual(features["history_sample_count_w2"], 1.0)
        self.assertEqual(features["club_matches_std"], 1.0)
        self.assertEqual(features["scoring_defensive_contributions"], 1.0)
        self.assertLess(features["history_points_per90_w2"], 20.0)

        cold_row = next(row for row in sidecar["rows"] if row["player_id"] == 3)
        cold = dict(zip(sidecar["feature_names"], cold_row["features"]))
        self.assertEqual(cold["known_price_m"], 7.0)
        self.assertEqual(cold["price_cold_start"], 1.0)
        self.assertEqual(cold["history_sample_count_std"], 0.0)

    def test_current_bootstrap_aggregates_and_target_outcomes_cannot_change_features(self) -> None:
        bootstrap, fixtures, summaries = fixture_payload()
        expected = self.build(bootstrap, fixtures, summaries)
        changed_bootstrap = copy.deepcopy(bootstrap)
        changed_bootstrap["elements"][0]["total_points"] = -999
        changed_bootstrap["elements"][0]["minutes"] = 99999
        changed_summaries = copy.deepcopy(summaries)
        changed_summaries[1]["history"][1]["total_points"] = -1000

        actual = self.build(changed_bootstrap, fixtures, changed_summaries)
        expected_vector = next(row["features"] for row in expected["rows"] if row["player_id"] == 1)
        actual_vector = next(row["features"] for row in actual["rows"] if row["player_id"] == 1)
        self.assertEqual(actual_vector, expected_vector)

    def test_post_deadline_capture_is_rejected(self) -> None:
        bootstrap, fixtures, summaries = fixture_payload()
        with self.assertRaisesRegex(pipeline.PipelineError, "after GW2 deadline"):
            generate_live_feature_sidecar(
                bootstrap,
                fixtures,
                summaries,
                season="2025-2026",
                target_gameweek=2,
                as_of=datetime(2025, 8, 15, 18, tzinfo=timezone.utc),
                scoring_defensive_contributions=True,
            )


if __name__ == "__main__":
    unittest.main()
