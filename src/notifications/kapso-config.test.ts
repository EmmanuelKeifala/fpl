import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  getKapsoWhatsAppConfig,
  hasKapsoWhatsAppConfig,
  normalizeWhatsAppRecipient,
} from './kapso-config.js';

test('Kapso WhatsApp is disabled by default', () => {
  assert.deepEqual(getKapsoWhatsAppConfig({}), {
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
  });
  assert.equal(hasKapsoWhatsAppConfig({}), false);
});

test('Kapso WhatsApp parses and normalizes a production template configuration', () => {
  const config = getKapsoWhatsAppConfig({
    KAPSO_WHATSAPP_ENABLED: 'true',
    KAPSO_API_KEY: 'secret-key',
    KAPSO_PHONE_NUMBER_ID: '123456789012345',
    KAPSO_WHATSAPP_TO: '+1 555 123 4567',
    KAPSO_WHATSAPP_MODE: 'template',
    KAPSO_WHATSAPP_TEMPLATE_NAME: 'fpl_agent_update',
    KAPSO_WHATSAPP_LANGUAGE: 'en_US',
    KAPSO_WHATSAPP_TEMPLATE_PARAMETER_NAME: 'update',
    KAPSO_WHATSAPP_TIMEOUT_SECONDS: '10',
    KAPSO_WHATSAPP_MAX_ATTEMPTS: '4',
  });
  assert.deepEqual(config, {
    enabled: true,
    apiKey: 'secret-key',
    phoneNumberId: '123456789012345',
    recipient: '15551234567',
    mode: 'template',
    templateName: 'fpl_agent_update',
    languageCode: 'en_US',
    templateParameterName: 'update',
    timeoutMs: 10_000,
    maxAttempts: 4,
  });
  assert.equal(hasKapsoWhatsAppConfig({
    KAPSO_WHATSAPP_ENABLED: 'true',
    KAPSO_API_KEY: 'secret-key',
    KAPSO_PHONE_NUMBER_ID: '123456789012345',
    KAPSO_WHATSAPP_TO: '+15551234567',
    KAPSO_WHATSAPP_TEMPLATE_NAME: 'fpl_agent_update',
  }), true);
});

test('Kapso WhatsApp rejects partial, ambiguous, or malformed configuration', () => {
  assert.throws(() => getKapsoWhatsAppConfig({ KAPSO_WHATSAPP_ENABLED: 'yes' }), /true or false/);
  assert.throws(() => getKapsoWhatsAppConfig({ KAPSO_WHATSAPP_ENABLED: 'true' }), /KAPSO_API_KEY/);
  assert.throws(() => normalizeWhatsAppRecipient('123'), /international number/);
  assert.throws(() => getKapsoWhatsAppConfig({
    KAPSO_WHATSAPP_ENABLED: 'true',
    KAPSO_API_KEY: 'secret-key',
    KAPSO_PHONE_NUMBER_ID: '123456789012345',
    KAPSO_WHATSAPP_TO: '+15551234567',
    KAPSO_WHATSAPP_MODE: 'template',
  }), /KAPSO_WHATSAPP_TEMPLATE_NAME/);
});
