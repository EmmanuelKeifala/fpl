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

- Save up to 5 free transfers
- Chips can be used twice per season (once per half)
- -4 points per hit beyond free transfers
