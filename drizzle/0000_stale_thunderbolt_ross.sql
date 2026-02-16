CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gameweek` integer NOT NULL,
	`decision_type` text NOT NULL,
	`action` text NOT NULL,
	`reasoning` text,
	`expected_points` real,
	`actual_points` real,
	`rank_before` integer,
	`rank_after` integer,
	`hits_taken` integer DEFAULT 0,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `gameweek_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`gameweek` integer NOT NULL,
	`total_points` integer,
	`overall_rank` integer,
	`gameweek_points` integer,
	`gameweek_rank` integer,
	`team_value` real,
	`bank` real,
	`chips_used` text,
	`transfers_made` integer,
	`transfers_cost` integer,
	`points_on_bench` integer,
	`captain_id` integer,
	`captain_points` integer,
	`created_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gameweek_snapshots_gameweek_unique` ON `gameweek_snapshots` (`gameweek`);