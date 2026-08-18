import 'dotenv/config';
import { sendKapsoWhatsAppUpdate } from './kapso.js';

export async function runKapsoSmokeCheck(): Promise<void> {
  const result = await sendKapsoWhatsAppUpdate({
    season: process.env.FPL_SEASON?.trim() || '2026-2027',
    gameweek: 0,
    stage: 'after',
    action: 'system',
    status: 'confirmed',
    summary: 'Kapso connectivity canary. No FPL action was taken.',
    details: { Purpose: 'WhatsApp delivery verification' },
    runMode: 'shadow',
  });
  console.log(JSON.stringify({
    configured: result.configured,
    delivered: result.delivered,
    attempts: result.attempts,
    providerMessageId: result.providerMessageId,
    error: result.error,
  }, null, 2));
  if (!result.delivered) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('kapso-smoke.ts') || process.argv[1]?.endsWith('kapso-smoke.js')) {
  runKapsoSmokeCheck().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
