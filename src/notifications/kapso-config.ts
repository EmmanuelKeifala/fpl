export type KapsoWhatsAppMode = 'template' | 'text';

export interface KapsoWhatsAppConfig {
  enabled: boolean;
  apiKey: string | null;
  phoneNumberId: string | null;
  recipient: string | null;
  mode: KapsoWhatsAppMode | null;
  templateName: string | null;
  languageCode: string | null;
  templateParameterName: string | null;
  timeoutMs: number | null;
  maxAttempts: number;
}

export function getKapsoWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): KapsoWhatsAppConfig {
  const enabled = booleanValue(env, 'KAPSO_WHATSAPP_ENABLED', false);
  if (!enabled) return {
    enabled: false,
    apiKey: null,
    phoneNumberId: null,
    recipient: null,
    mode: null,
    templateName: null,
    languageCode: null,
    templateParameterName: null,
    timeoutMs: null,
    maxAttempts: 0,
  };

  const apiKey = required(env, 'KAPSO_API_KEY');
  const phoneNumberId = required(env, 'KAPSO_PHONE_NUMBER_ID');
  if (!/^\d{5,30}$/.test(phoneNumberId)) {
    throw new Error('KAPSO_PHONE_NUMBER_ID must contain 5 to 30 digits');
  }
  const recipient = normalizeWhatsAppRecipient(required(env, 'KAPSO_WHATSAPP_TO'));
  const mode = enumValue(env, 'KAPSO_WHATSAPP_MODE', ['template', 'text'] as const, 'template');
  const templateName = mode === 'template' ? required(env, 'KAPSO_WHATSAPP_TEMPLATE_NAME') : null;
  if (templateName && !/^[a-z0-9_]{1,512}$/.test(templateName)) {
    throw new Error('KAPSO_WHATSAPP_TEMPLATE_NAME must use lowercase letters, digits, and underscores');
  }
  const languageCode = mode === 'template'
    ? env.KAPSO_WHATSAPP_LANGUAGE?.trim() || 'en_US'
    : null;
  if (languageCode && !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(languageCode)) {
    throw new Error('KAPSO_WHATSAPP_LANGUAGE must be a WhatsApp language code such as en_US');
  }
  const templateParameterName = mode === 'template'
    ? env.KAPSO_WHATSAPP_TEMPLATE_PARAMETER_NAME?.trim() || 'update'
    : null;
  if (templateParameterName && !/^[a-z][a-z0-9_]{0,59}$/.test(templateParameterName)) {
    throw new Error('KAPSO_WHATSAPP_TEMPLATE_PARAMETER_NAME must be a valid named template parameter');
  }

  return {
    enabled: true,
    apiKey,
    phoneNumberId,
    recipient,
    mode,
    templateName,
    languageCode,
    templateParameterName,
    timeoutMs: integerValue(env, 'KAPSO_WHATSAPP_TIMEOUT_SECONDS', 3, 20, 8) * 1000,
    maxAttempts: integerValue(env, 'KAPSO_WHATSAPP_MAX_ATTEMPTS', 1, 5, 3),
  };
}

export function normalizeWhatsAppRecipient(value: string): string {
  const normalized = value.trim().replace(/^\+/, '').replace(/[\s()-]/g, '');
  if (!/^\d{8,15}$/.test(normalized)) {
    throw new Error('KAPSO_WHATSAPP_TO must be an international number with 8 to 15 digits');
  }
  return normalized;
}

export function hasKapsoWhatsAppConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return getKapsoWhatsAppConfig(env).enabled;
  } catch {
    return false;
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when KAPSO_WHATSAPP_ENABLED=true`);
  return value;
}

function booleanValue(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = (env[name] ?? String(fallback)).trim().toLowerCase();
  if (raw !== 'true' && raw !== 'false') throw new Error(`${name} must be true or false`);
  return raw === 'true';
}

function enumValue<const T extends readonly string[]>(
  env: NodeJS.ProcessEnv,
  name: string,
  values: T,
  fallback: T[number]
): T[number] {
  const raw = (env[name] ?? fallback).trim();
  if (!values.includes(raw)) throw new Error(`${name} must be one of: ${values.join(', ')}`);
  return raw as T[number];
}

function integerValue(
  env: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  const raw = (env[name] ?? String(fallback)).trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}
