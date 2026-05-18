# FPL Agent

AI-powered Fantasy Premier League assistant with game theory optimization.

## Features

- **Team Analysis**: View your squad with expected points projections
- **Player Stats**: Detailed player data with form and fixtures
- **Transfer Optimization**: Smart recommendations using hit ROI analysis
- **Chip Timing**: Optimal chip usage based on fixture analysis
- **Performance Tracking**: SQLite database tracks all decisions

## Setup

1. Copy environment file:
   ```bash
   cp .env.example .env
   ```

2. Add your credentials to `.env`:
   - `OPENAI_API_KEY`: Your OpenAI API key
   - `FPL_EMAIL`: Your FPL login email
   - `FPL_PASSWORD`: Your FPL password
   - `FPL_MANAGER_ID`: Your manager ID (from team URL)

3. Install dependencies:
   ```bash
   npm install
   ```

4. Run the agent:
   ```bash
   npm run dev
   ```

## Usage

Ask the agent questions like:
- "Show me my team"
- "How is Salah performing?"
- "Should I take a hit for Haaland?"
- "What are the trending transfers?"
- "When should I use my bench boost?"

## FPL Rules (2025/26)

- Squad: 15 players, 2 GKP / 5 DEF / 5 MID / 3 FWD
- Starting XI: 1 GKP, at least 3 DEF, at least 2 MID, at least 1 FWD
- Save up to 5 free transfers
- -4 points per transfer beyond available free transfers
- Max 20 transfers in a GW unless using Wildcard or Free Hit
- Chips are split around the GW19 deadline: 2 Bench Boosts, 2 Triple Captains, 2 Free Hits, 2 Wildcards
- Only one chip can be played per GW
- Defensive contribution points are included in projections
- Price selling keeps half of profit rounded down to £0.1m
