// FPL Agent CLI Entry Point with Streaming
import 'dotenv/config';
import { run } from '@openai/agents';
import * as readline from 'readline';
import { fplAgent } from './agent.js';
import { getFPLClient } from './api/client.js';
import { getOptimizationEngine } from './engine/optimizer.js';
import { syncGameweekData } from './db/sync.js';

// ANSI colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

function printBanner(): void {
  console.log(`
${colors.cyan}${colors.bright}
  +-----------------------------------------------------------+
  |                                                           |
  |   [*]  FPL AGENT - AI-Powered Fantasy Manager  [*]        |
  |                                                           |
  |   Game Theory Optimization * Smart Transfers * Chips      |
  |                                                           |
  +-----------------------------------------------------------+
${colors.reset}
  ${colors.dim}Type your questions or commands. Type /help for options.${colors.reset}
  `);
}

function printHelp(): void {
  console.log(`
${colors.bright}Available Commands:${colors.reset}
  ${colors.cyan}/help${colors.reset}      - Show this help message
  ${colors.cyan}/team${colors.reset}      - Quick view of your current team
  ${colors.cyan}/trends${colors.reset}    - Show trending transfers
  ${colors.cyan}/fixtures${colors.reset}  - Show fixture difficulty ratings
  ${colors.cyan}/captain${colors.reset}   - Show captain recommendations
  ${colors.cyan}/perf${colors.reset}      - Show your decision performance
  ${colors.cyan}/sync${colors.reset}      - Sync current GW data to database
  ${colors.cyan}/clear${colors.reset}     - Clear screen
  ${colors.cyan}/quit${colors.reset}      - Exit the agent

${colors.bright}Example Questions:${colors.reset}
  - Show me my team
  - How is Salah performing?
  - Should I transfer out Watkins for Isak?
  - What are the best fixtures this week?
  - When should I use my bench boost?
  - How have my transfers performed?
  - Who should I captain this week?
  - Plan a wildcard with 5 transfers
  `);
}

async function initializeAgent(): Promise<void> {
  console.log(`${colors.dim}Initializing FPL Agent...${colors.reset}`);
  
  // Check for required environment variables
  if (!process.env.OPENAI_API_KEY) {
    console.error(`${colors.yellow}Warning: OPENAI_API_KEY not set. Please set it in your .env file.${colors.reset}`);
    process.exit(1);
  }
  
  // Initialize FPL client
  const managerId = process.env.FPL_MANAGER_ID ? parseInt(process.env.FPL_MANAGER_ID) : undefined;
  const client = getFPLClient(
    process.env.FPL_EMAIL,
    process.env.FPL_PASSWORD,
    managerId
  );
  
  // Try to authenticate if credentials provided
  if (process.env.FPL_EMAIL && process.env.FPL_PASSWORD) {
    console.log(`${colors.dim}Authenticating with FPL...${colors.reset}`);
    try {
      const success = await client.login();
      if (success) {
        console.log(`${colors.green}Authenticated successfully!${colors.reset}`);
      } else {
        console.log(`${colors.yellow}Authentication failed. Some features will be limited.${colors.reset}`);
      }
    } catch (error) {
      console.log(`${colors.yellow}Authentication error. Continuing in read-only mode.${colors.reset}`);
    }
  } else if (managerId) {
    console.log(`${colors.dim}Using manager ID: ${managerId} (read-only mode)${colors.reset}`);
  } else {
    console.log(`${colors.yellow}No FPL credentials provided. Set FPL_MANAGER_ID for basic features.${colors.reset}`);
  }
  
  // Pre-load optimization engine data
  console.log(`${colors.dim}Loading FPL data...${colors.reset}`);
  try {
    const engine = await getOptimizationEngine();
    console.log(`${colors.green}Data loaded! Current gameweek: GW${engine.getCurrentGameweek()}${colors.reset}`);
  } catch (error) {
    console.log(`${colors.yellow}Warning: Could not load FPL data. Some features may not work.${colors.reset}`);
  }
}

async function handleShortcut(command: string): Promise<string | null> {
  switch (command.toLowerCase()) {
    case '/team':
      return 'Show me my current FPL team with expected points for each player';
    case '/trends':
      return 'Show me the trending transfers and price change predictions';
    case '/fixtures':
      return 'Show me the fixture difficulty ratings for all teams';
    case '/captain':
      return 'Who should I captain this week? Show me alternatives with xP';
    case '/perf':
      return 'Show me my decision performance summary';
    case '/sync':
      // Handle sync directly
      console.log(`${colors.dim}Syncing current gameweek data...${colors.reset}`);
      const result = await syncGameweekData();
      console.log(result.synced 
        ? `${colors.green}${result.message}${colors.reset}`
        : `${colors.yellow}${result.message}${colors.reset}`
      );
      return null; // No agent call needed
    default:
      return null;
  }
}

// Stream output character by character
async function streamOutput(text: string, delay: number = 5): Promise<void> {
  for (const char of text) {
    process.stdout.write(char);
    if (delay > 0 && (char === '.' || char === '!' || char === '?' || char === '\n')) {
      await new Promise(resolve => setTimeout(resolve, delay * 5));
    } else if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function runConversation(): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  
  const prompt = (): Promise<string> => {
    return new Promise((resolve) => {
      rl.question(`\n${colors.bright}You:${colors.reset} `, (answer) => {
        resolve(answer.trim());
      });
    });
  };
  
  printBanner();
  await initializeAgent();
  console.log('');
  
  while (true) {
    const userInput = await prompt();
    
    // Handle special commands
    if (!userInput) continue;
    
    if (userInput === '/quit' || userInput === '/exit') {
      console.log(`\n${colors.cyan}Thanks for using FPL Agent! Good luck with your team!${colors.reset}\n`);
      rl.close();
      break;
    }
    
    if (userInput === '/help') {
      printHelp();
      continue;
    }
    
    if (userInput === '/clear') {
      console.clear();
      printBanner();
      continue;
    }
    
    // Check for shortcuts
    const expandedInput = await handleShortcut(userInput);
    if (expandedInput === null && userInput.startsWith('/')) {
      // Command was handled or invalid
      if (!userInput.match(/^\/(team|trends|fixtures|captain|perf|sync)$/)) {
        console.log(`${colors.yellow}Unknown command. Type /help for available commands.${colors.reset}`);
      }
      continue;
    }
    
    const messageToSend = expandedInput || userInput;
    
    console.log(`\n${colors.magenta}${colors.bright}FPL Agent:${colors.reset} ${colors.dim}Thinking...${colors.reset}`);
    
    try {
      // Run the agent with streaming
      const result = await run(fplAgent, messageToSend);
      
      // Get the response
      const response = result.finalOutput || 'I apologize, but I could not generate a response.';
      
      // Clear "Thinking..." and print streamed response
      process.stdout.write('\x1b[1A\x1b[2K'); // Move up and clear line
      console.log(`\n${colors.magenta}${colors.bright}FPL Agent:${colors.reset}`);
      
      // Stream the response
      if (typeof response === 'string') {
        await streamOutput(response, 2); // Fast streaming
        console.log(''); // New line after response
      } else {
        console.log(JSON.stringify(response, null, 2));
      }
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`\n${colors.yellow}Error: ${errorMessage}${colors.reset}`);
      
      if (errorMessage.includes('API key')) {
        console.log(`${colors.dim}Make sure OPENAI_API_KEY is set in your .env file.${colors.reset}`);
      }
    }
  }
}

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error(`\n${colors.yellow}Unexpected error: ${error.message}${colors.reset}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`\n${colors.yellow}Unhandled rejection: ${reason}${colors.reset}`);
});

// Run the CLI
runConversation().catch(console.error);
