// Notifications for Autonomous Mode
import type { Player } from '../api/types.js';

export interface NotificationPayload {
  type: 'transfer' | 'captain' | 'chip' | 'alert' | 'summary';
  title: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: Date;
}

// Format notification as console log
function logNotification(payload: NotificationPayload): void {
  const prefix = {
    transfer: '[TRANSFER]',
    captain: '[CAPTAIN]',
    chip: '[CHIP]',
    alert: '[ALERT]',
    summary: '[SUMMARY]',
  }[payload.type];
  
  console.log(`\n${prefix} ${payload.title}`);
  console.log(`  ${payload.message}`);
  if (payload.data) {
    console.log(`  Data: ${JSON.stringify(payload.data, null, 2)}`);
  }
}

// Send to Discord webhook
async function sendDiscord(payload: NotificationPayload): Promise<boolean> {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) return false;
  
  try {
    const embed = {
      title: payload.title,
      description: payload.message,
      color: {
        transfer: 0x00ff00,
        captain: 0x0099ff,
        chip: 0xff9900,
        alert: 0xff0000,
        summary: 0x9900ff,
      }[payload.type],
      timestamp: payload.timestamp.toISOString(),
      fields: payload.data ? Object.entries(payload.data).map(([name, value]) => ({
        name,
        value: String(value),
        inline: true,
      })) : undefined,
    };
    
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    
    return response.ok;
  } catch (error) {
    console.error('[NOTIFY] Discord webhook failed:', error);
    return false;
  }
}

// Send to Telegram
async function sendTelegram(payload: NotificationPayload): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return false;
  
  try {
    const text = `*${payload.title}*\n${payload.message}`;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'Markdown',
      }),
    });
    
    return response.ok;
  } catch (error) {
    console.error('[NOTIFY] Telegram send failed:', error);
    return false;
  }
}

// Main notification function
export async function notify(payload: NotificationPayload): Promise<void> {
  // Always log to console
  logNotification(payload);
  
  // Send to Discord if configured
  await sendDiscord(payload);
  
  // Send to Telegram if configured
  await sendTelegram(payload);
}

// Convenience functions
export async function notifyTransfer(
  playerOut: Player,
  playerIn: Player,
  xpGain: number,
  hitCost: number
): Promise<void> {
  await notify({
    type: 'transfer',
    title: 'Transfer Executed',
    message: `${playerOut.web_name} OUT -> ${playerIn.web_name} IN`,
    data: {
      'xP Gain': xpGain.toFixed(1),
      'Hit Cost': hitCost > 0 ? `-${hitCost}` : 'Free',
      'Net Gain': (xpGain - hitCost).toFixed(1),
    },
    timestamp: new Date(),
  });
}

export async function notifyCaptain(
  captain: Player,
  xpExpected: number,
  alternatives: string[]
): Promise<void> {
  await notify({
    type: 'captain',
    title: 'Captain Selected',
    message: `${captain.web_name} set as captain`,
    data: {
      'Expected Points': xpExpected.toFixed(1),
      'Doubled': (xpExpected * 2).toFixed(1),
      'Alternatives': alternatives.slice(0, 3).join(', '),
    },
    timestamp: new Date(),
  });
}

export async function notifyChip(
  chip: string,
  gameweek: number,
  expectedGain: number,
  executed: boolean
): Promise<void> {
  await notify({
    type: 'chip',
    title: executed ? `${chip} Activated` : `${chip} Recommended`,
    message: executed 
      ? `Chip activated for GW${gameweek}`
      : `Consider playing ${chip} in GW${gameweek}`,
    data: {
      'Gameweek': gameweek,
      'Expected Gain': expectedGain.toFixed(1),
      'Status': executed ? 'Executed' : 'Logged Only',
    },
    timestamp: new Date(),
  });
}

export async function notifyAlert(title: string, message: string): Promise<void> {
  await notify({
    type: 'alert',
    title,
    message,
    timestamp: new Date(),
  });
}

export async function notifySummary(
  gameweek: number,
  points: number,
  rank: number,
  decisions: number
): Promise<void> {
  await notify({
    type: 'summary',
    title: `GW${gameweek} Summary`,
    message: `${points} points | Rank: ${rank.toLocaleString()}`,
    data: {
      'Decisions Made': decisions,
      'Gameweek Points': points,
      'Overall Rank': rank.toLocaleString(),
    },
    timestamp: new Date(),
  });
}
