import { createHash } from 'node:crypto';
import { getKapsoWhatsAppConfig, type KapsoWhatsAppConfig } from './kapso-config.js';

const KAPSO_API_VERSION = 'v24.0';
const MAX_MESSAGE_LENGTH = 3_500;
const RETRY_BASE_MS = 250;

export type KapsoUpdateStage = 'plan' | 'before' | 'after';
export type KapsoUpdateStatus = 'planned' | 'starting' | 'confirmed' | 'failed' | 'unknown' | 'blocked' | 'shadow';

export interface KapsoWhatsAppUpdate {
  season: string;
  gameweek: number;
  stage: KapsoUpdateStage;
  action: 'gameweek-plan' | 'transfer' | 'lineup' | 'chip' | 'gameweek-summary' | 'system';
  status: KapsoUpdateStatus;
  summary: string;
  details?: Record<string, string | number | boolean | null | readonly string[]>;
  runMode: 'shadow' | 'live';
  timestamp?: Date;
  dedupeKey?: string;
  sequenceKey?: string;
}

export interface KapsoDeliveryResult {
  configured: boolean;
  delivered: boolean;
  providerMessageId: string | null;
  attempts: number;
  error: string | null;
}

export interface KapsoDependencies {
  fetch: typeof fetch;
  sleep: (milliseconds: number) => Promise<void>;
}

type KapsoSender = (
  update: KapsoWhatsAppUpdate,
  env?: NodeJS.ProcessEnv,
  dependencies?: Partial<KapsoDependencies>
) => Promise<KapsoDeliveryResult>;

const pendingDeliveries = new Set<Promise<void>>();
const deliveredDedupeKeys = new Set<string>();
const queuedDedupeKeys = new Set<string>();
const deliveryTails = new Map<string, Promise<void>>();

export async function sendKapsoWhatsAppUpdate(
  update: KapsoWhatsAppUpdate,
  env: NodeJS.ProcessEnv = process.env,
  dependencyOverrides: Partial<KapsoDependencies> = {}
): Promise<KapsoDeliveryResult> {
  let config: KapsoWhatsAppConfig;
  try {
    config = getKapsoWhatsAppConfig(env);
  } catch (error) {
    return result(false, false, null, 0, errorMessage(error));
  }
  if (!config.enabled) return result(false, false, null, 0, 'Kapso WhatsApp is disabled');

  const dependencies: KapsoDependencies = {
    fetch: dependencyOverrides.fetch ?? fetch,
    sleep: dependencyOverrides.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))),
  };
  const body = formatKapsoWhatsAppUpdate(update);
  const requestBody = buildRequestBody(config, body, update);
  const endpoint = `https://api.kapso.ai/meta/whatsapp/${KAPSO_API_VERSION}/${config.phoneNumberId}/messages`;
  let lastError = 'Kapso delivery failed';

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const response = await dependencies.fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': config.apiKey!,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(config.timeoutMs!),
      });
      const parsed = await response.json().catch(() => null) as unknown;
      if (response.ok) {
        const providerMessageId = extractMessageId(parsed);
        if (!providerMessageId) {
          return result(true, false, null, attempt, 'Kapso returned success without a WhatsApp message ID');
        }
        return result(true, true, providerMessageId, attempt, null);
      }
      lastError = safeProviderError(parsed, response.status);
      if (!isTransientStatus(response.status) || attempt === config.maxAttempts) {
        return result(true, false, null, attempt, lastError);
      }
    } catch (error) {
      lastError = errorMessage(error);
      if (attempt === config.maxAttempts) return result(true, false, null, attempt, lastError);
    }
    await dependencies.sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
  }

  return result(true, false, null, config.maxAttempts, lastError);
}

// Delivery is serialized to preserve before -> after ordering, but the runner
// never awaits this queue before an FPL mutation. WhatsApp cannot authorize,
// cancel, delay, or otherwise alter a team action.
export function queueKapsoWhatsAppUpdate(
  update: KapsoWhatsAppUpdate,
  env: NodeJS.ProcessEnv = process.env,
  sender: KapsoSender = sendKapsoWhatsAppUpdate
): void {
  const dedupeKey = update.dedupeKey?.trim();
  if (dedupeKey && (deliveredDedupeKeys.has(dedupeKey) || queuedDedupeKeys.has(dedupeKey))) return;
  if (dedupeKey) queuedDedupeKeys.add(dedupeKey);

  const sequenceKey = update.sequenceKey?.trim()
    || `independent:${dedupeKey ?? callbackData(update)}`;
  const deliver = async (): Promise<void> => {
      const delivery = await sender(update, env);
      if (delivery.delivered) {
        if (dedupeKey) deliveredDedupeKeys.add(dedupeKey);
        console.log(`[KAPSO] Delivered ${update.stage}/${update.action} update for GW${update.gameweek}.`);
      } else if (delivery.configured) {
        console.error(`[KAPSO] Failed ${update.stage}/${update.action} update for GW${update.gameweek}: ${delivery.error}`);
      }
  };
  const predecessor = deliveryTails.get(sequenceKey);
  let job!: Promise<void>;
  job = (predecessor ? predecessor.then(deliver) : deliver())
    .catch(error => {
      console.error(`[KAPSO] Unexpected notification failure for GW${update.gameweek}: ${errorMessage(error)}`);
    })
    .finally(() => {
      if (dedupeKey) queuedDedupeKeys.delete(dedupeKey);
      if (deliveryTails.get(sequenceKey) === job) deliveryTails.delete(sequenceKey);
    });
  deliveryTails.set(sequenceKey, job);
  pendingDeliveries.add(job);
  void job.finally(() => pendingDeliveries.delete(job));
}

export async function flushKapsoWhatsAppUpdates(timeoutMs = 5_000): Promise<boolean> {
  if (pendingDeliveries.size === 0) return true;
  let timeout: NodeJS.Timeout | undefined;
  const completed = await Promise.race([
    Promise.allSettled([...pendingDeliveries]).then(() => true),
    new Promise<boolean>(resolve => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return completed;
}

export function formatKapsoWhatsAppUpdate(update: KapsoWhatsAppUpdate): string {
  const lines = [
    `FPL Agent · GW${update.gameweek}`,
    `${update.stage.toUpperCase()} · ${humanize(update.action)}`,
    `Mode: ${update.runMode.toUpperCase()}`,
    `Status: ${humanize(update.status)}`,
    update.summary.trim(),
  ];
  for (const [name, value] of Object.entries(update.details ?? {})) {
    const formatted = Array.isArray(value) ? value.join(', ') : String(value ?? 'none');
    lines.push(`${name}: ${formatted}`);
  }
  lines.push(`Time: ${(update.timestamp ?? new Date()).toISOString()}`);
  const body = lines.join('\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return body.length <= MAX_MESSAGE_LENGTH ? body : `${body.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

function buildRequestBody(
  config: KapsoWhatsAppConfig,
  body: string,
  update: KapsoWhatsAppUpdate
): Record<string, unknown> {
  const base = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: config.recipient,
    biz_opaque_callback_data: callbackData(update),
  };
  if (config.mode === 'text') {
    return { ...base, type: 'text', text: { body, preview_url: false } };
  }
  const templateParameter = formatTemplateParameter(body);
  return {
    ...base,
    type: 'template',
    template: {
      name: config.templateName,
      language: { code: config.languageCode },
      components: [{
        type: 'body',
        parameters: [{
          type: 'text',
          parameter_name: config.templateParameterName,
          text: templateParameter,
        }],
      }],
    },
  };
}

// Meta template parameter values reject line breaks, tabs, and runs of more
// than four spaces. Keep the detailed layout in text mode while giving the
// approved single-variable template a readable, provider-safe value.
function formatTemplateParameter(body: string): string {
  return body
    .replace(/[\r\n\t\u2028\u2029]+/g, ' · ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function callbackData(update: KapsoWhatsAppUpdate): string {
  const source = `${update.season}|${update.gameweek}|${update.stage}|${update.action}|${update.status}|${update.dedupeKey ?? ''}`;
  return `fpl:${createHash('sha256').update(source).digest('hex').slice(0, 32)}`;
}

function extractMessageId(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const first = value.messages[0];
  return isRecord(first) && typeof first.id === 'string' && first.id.trim() ? first.id : null;
}

function safeProviderError(value: unknown, status: number): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === 'string') {
    return `HTTP ${status}: ${value.error.message.slice(0, 300)}`;
  }
  return `HTTP ${status}`;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function humanize(value: string): string {
  return value.replace(/-/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function result(
  configured: boolean,
  delivered: boolean,
  providerMessageId: string | null,
  attempts: number,
  error: string | null
): KapsoDeliveryResult {
  return { configured, delivered, providerMessageId, attempts, error };
}
