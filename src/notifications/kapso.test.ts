import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  flushKapsoWhatsAppUpdates,
  formatKapsoWhatsAppUpdate,
  queueKapsoWhatsAppUpdate,
  sendKapsoWhatsAppUpdate,
  type KapsoDeliveryResult,
  type KapsoWhatsAppUpdate,
} from './kapso.js';

function update(overrides: Partial<KapsoWhatsAppUpdate> = {}): KapsoWhatsAppUpdate {
  return {
    season: '2026-2027',
    gameweek: 1,
    stage: 'before',
    action: 'transfer',
    status: 'starting',
    summary: 'Player A -> Player B',
    details: { 'Net gain': '3.2 xP', Transfers: 1 },
    runMode: 'live',
    timestamp: new Date('2026-08-21T16:00:00.000Z'),
    ...overrides,
  };
}

function environment(mode: 'template' | 'text' = 'template'): NodeJS.ProcessEnv {
  return {
    KAPSO_WHATSAPP_ENABLED: 'true',
    KAPSO_API_KEY: 'test-api-key',
    KAPSO_PHONE_NUMBER_ID: '123456789012345',
    KAPSO_WHATSAPP_TO: '+15551234567',
    KAPSO_WHATSAPP_MODE: mode,
    KAPSO_WHATSAPP_TEMPLATE_NAME: 'fpl_agent_update',
    KAPSO_WHATSAPP_LANGUAGE: 'en_US',
    KAPSO_WHATSAPP_TEMPLATE_PARAMETER_NAME: 'update',
    KAPSO_WHATSAPP_MAX_ATTEMPTS: '3',
  };
}

test('Kapso sends the approved named-parameter template through the official messages endpoint', async () => {
  let requestedUrl = '';
  let requestedInit: RequestInit | undefined;
  const delivery = await sendKapsoWhatsAppUpdate(update(), environment(), {
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      requestedInit = init;
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.123' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch,
  });

  assert.equal(delivery.delivered, true);
  assert.equal(delivery.providerMessageId, 'wamid.123');
  assert.equal(delivery.attempts, 1);
  assert.equal(requestedUrl, 'https://api.kapso.ai/meta/whatsapp/v24.0/123456789012345/messages');
  assert.equal(new Headers(requestedInit?.headers).get('X-API-Key'), 'test-api-key');
  const payload = JSON.parse(String(requestedInit?.body)) as Record<string, any>;
  assert.equal(payload.to, '15551234567');
  assert.equal(payload.type, 'template');
  assert.equal(payload.template.name, 'fpl_agent_update');
  assert.equal(payload.template.language.code, 'en_US');
  assert.equal(payload.template.components[0].parameters[0].parameter_name, 'update');
  assert.match(payload.template.components[0].parameters[0].text, /BEFORE · Transfer/);
  assert.match(payload.biz_opaque_callback_data, /^fpl:[a-f0-9]{32}$/);
});

test('Kapso supports text canaries and retries only transient responses', async () => {
  const attempts: number[] = [];
  const sleeps: number[] = [];
  const delivery = await sendKapsoWhatsAppUpdate(update({ action: 'system' }), environment('text'), {
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      attempts.push(1);
      const payload = JSON.parse(String(init?.body)) as Record<string, any>;
      assert.equal(payload.type, 'text');
      assert.equal(payload.text.preview_url, false);
      if (attempts.length < 3) return new Response(JSON.stringify({ error: { message: 'try again' } }), { status: 503 });
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.retry' }] }), { status: 200 });
    }) as typeof fetch,
    sleep: async milliseconds => { sleeps.push(milliseconds); },
  });
  assert.equal(delivery.delivered, true);
  assert.equal(delivery.attempts, 3);
  assert.deepEqual(sleeps, [250, 500]);

  let authAttempts = 0;
  const rejected = await sendKapsoWhatsAppUpdate(update(), environment(), {
    fetch: (async () => {
      authAttempts++;
      return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 401 });
    }) as typeof fetch,
    sleep: async () => assert.fail('authentication failures must not be retried'),
  });
  assert.equal(rejected.delivered, false);
  assert.equal(rejected.attempts, 1);
  assert.equal(authAttempts, 1);
});

test('Kapso queue preserves before/after order without awaiting or controlling the FPL path', async () => {
  const calls: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const sender = async (item: KapsoWhatsAppUpdate): Promise<KapsoDeliveryResult> => {
    calls.push(`start:${item.stage}`);
    if (item.stage === 'before') await firstGate;
    calls.push(`finish:${item.stage}`);
    return { configured: true, delivered: true, providerMessageId: `id-${item.stage}`, attempts: 1, error: null };
  };

  queueKapsoWhatsAppUpdate(update({ stage: 'before', sequenceKey: 'transfer-attempt' }), {}, sender);
  queueKapsoWhatsAppUpdate(update({ stage: 'after', status: 'confirmed', sequenceKey: 'transfer-attempt' }), {}, sender);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['start:before']);
  releaseFirst();
  assert.equal(await flushKapsoWhatsAppUpdates(1_000), true);
  assert.deepEqual(calls, ['start:before', 'finish:before', 'start:after', 'finish:after']);
});

test('Kapso formatting is bounded and excludes control characters', () => {
  const formatted = formatKapsoWhatsAppUpdate(update({ summary: `ok\u0000${'x'.repeat(4_000)}` }));
  assert.ok(formatted.length <= 3_500);
  assert.equal(formatted.includes('\u0000'), false);
});
