"""Dependency-free tests for the local ML feature and export contracts."""

from __future__ import annotations

import math
import unittest
from datetime import datetime, timezone

from scripts.ml import pipeline


class FeatureContractTest(unittest.TestCase):
    def test_identity_fields_are_not_fitted(self) -> None:
        self.assertFalse(
            set(pipeline.IDENTITY_FIELDS_EXCLUDED).intersection(pipeline.FEATURE_NAMES)
        )

    def test_position_is_fixed_one_hot(self) -> None:
        position_features = tuple(
            name for name in pipeline.FEATURE_NAMES if name.startswith("position_")
        )
        self.assertEqual(
            position_features,
            ("position_gk", "position_def", "position_mid", "position_fwd"),
        )

    def test_same_gameweek_event_is_excluded(self) -> None:
        kickoff = datetime(2024, 8, 20, tzinfo=timezone.utc)
        prior = pipeline.PlayerEvent(
            gameweek=1,
            kickoff=datetime(2024, 8, 10, tzinfo=timezone.utc),
            minutes=90.0,
            appearance=1.0,
            start=1.0,
            total_points=6.0,
            expected_goals=0.2,
            expected_assists=0.1,
            expected_goals_conceded=1.0,
            clean_sheets=1.0,
            saves=0.0,
            bonus=1.0,
            goals=0.0,
            assists=1.0,
            cards=0.0,
            defensive_contribution=None,
        )
        same_gameweek = pipeline.PlayerEvent(
            gameweek=2,
            kickoff=datetime(2024, 8, 19, tzinfo=timezone.utc),
            minutes=90.0,
            appearance=1.0,
            start=1.0,
            total_points=100.0,
            expected_goals=10.0,
            expected_assists=10.0,
            expected_goals_conceded=0.0,
            clean_sheets=1.0,
            saves=0.0,
            bonus=3.0,
            goals=10.0,
            assists=10.0,
            cards=0.0,
            defensive_contribution=None,
        )
        summary = pipeline._player_summary(
            [prior, same_gameweek], "MID", 2, kickoff, 2
        )
        self.assertEqual(summary["sample_count"], 1.0)
        self.assertEqual(summary["minutes"], 90.0)

    def test_exact_source_rows_are_deduplicated(self) -> None:
        kickoff = datetime(2025, 8, 15, tzinfo=timezone.utc)
        row = pipeline.RawRow(
            season="2025-2026",
            gameweek=1,
            fixture_id=1,
            player_id=10,
            player_name="Example",
            position="MID",
            team_id=1,
            team_name="Example FC",
            opponent_id=2,
            kickoff=kickoff,
            was_home=True,
            price_m=5.0,
            minutes=0.0,
            starts=0.0,
            total_points=0.0,
            expected_goals=0.0,
            expected_assists=0.0,
            expected_goals_conceded=0.0,
            clean_sheets=0.0,
            saves=0.0,
            bonus=0.0,
            goals=0.0,
            assists=0.0,
            cards=0.0,
            defensive_contribution=0.0,
            home_score=1.0,
            away_score=0.0,
        )
        unique, count = pipeline._deduplicate_gameweek_rows([row, row])
        self.assertEqual(unique, [row])
        self.assertEqual(count, 1)

    def test_second_double_gameweek_fixture_uses_known_schedule_for_rest(self) -> None:
        previous = pipeline.TeamEvent(
            gameweek=1,
            kickoff=datetime(2025, 8, 1, 12, tzinfo=timezone.utc),
            goals_for=1,
            goals_against=1,
        )
        first = datetime(2025, 8, 10, 12, tzinfo=timezone.utc)
        second = datetime(2025, 8, 14, 18, tzinfo=timezone.utc)

        rest, missing = pipeline._rest_features([previous], 2, second, [first, second])

        self.assertAlmostEqual(rest, 4.25)
        self.assertEqual(missing, 0.0)


class PortableInferenceTest(unittest.TestCase):
    def test_tree_and_sigmoid(self) -> None:
        model = {
            "base_score": 0.0,
            "learning_rate": 0.5,
            "link": "sigmoid",
            "trees": [
                {
                    "children_left": [1, -1, -1],
                    "children_right": [2, -1, -1],
                    "feature_index": [0, -2, -2],
                    "threshold": [1.5, -2.0, -2.0],
                    "value": [0.0, -2.0, 4.0],
                }
            ],
        }
        left = pipeline.predict_serialized_one(model, [1.5])
        right = pipeline.predict_serialized_one(model, [2.0])
        self.assertAlmostEqual(left, 1.0 / (1.0 + math.exp(1.0)))
        self.assertAlmostEqual(right, 1.0 / (1.0 + math.exp(-2.0)))


if __name__ == "__main__":
    unittest.main()
