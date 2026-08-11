// FPL account authentication.
//
// FPL retired users.premierleague.com; accounts now sign in through
// account.premierleague.com, a PingOne DaVinci flow in front of an OAuth
// authorization-code + PKCE exchange. This module drives that flow with the
// manager's own credentials and returns the resulting tokens.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setDefaultResultOrder } from 'node:dns';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// The auth host advertises AAAA records that are not reachable from every
// network, and Node's happy-eyeballs stalls for 20s+ before falling back.
setDefaultResultOrder('ipv4first');

const AUTH_BASE = 'https://account.premierleague.com';
const REDIRECT_URI = 'https://fantasy.premierleague.com/';
const CLIENT_ID = process.env.FPL_OAUTH_CLIENT_ID ?? 'bfcbaf69-aade-4c1b-8f00-c1cb8a193030';
const SESSION_FILE = process.env.FPL_SESSION_FILE ?? 'data/fpl-session.json';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const NAVIGATION_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Upgrade-Insecure-Requests': '1',
  Referer: REDIRECT_URI,
};

export interface FPLTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  /** Epoch milliseconds at which the access token stops being valid. */
  expiresAt: number;
}

export class FPLLoginError extends Error {
  constructor(message: string, readonly step: string) {
    super(message);
    this.name = 'FPLLoginError';
  }
}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

/**
 * The flow is cookie-stateful: /davinci/policy/.../start issues an interactionId
 * cookie and the credential step issues the SSO cookies. Requests fail without them.
 */
class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator > 0) this.cookies.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim());
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

async function resilientFetch(
  url: string,
  init: RequestInit,
  step: string,
  jar?: CookieJar,
  attempts = 6
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
      jar?.absorb(response);
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 1_000 * attempt));
    }
  }

  throw new FPLLoginError(
    `Network failure during ${step}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    step
  );
}

/**
 * The authorize page embeds its DaVinci widget configuration as a JSON object
 * literal. Brace-match it rather than regexing, because it contains nested objects.
 */
function extractWidgetProps(html: string): { policyId: string; accessToken: string } {
  const marker = 'var skProps = ';
  const start = html.indexOf(marker);
  if (start === -1) {
    throw new FPLLoginError('Authorize page did not contain the expected login widget', 'authorize');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start + marker.length; index < html.length; index++) {
    const char = html[index]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      const props = JSON.parse(html.slice(start + marker.length, index + 1));
      if (!props.policyId || !props.accessToken) {
        throw new FPLLoginError('Login widget is missing its policy or bootstrap token', 'authorize');
      }
      return { policyId: props.policyId, accessToken: props.accessToken };
    }
  }

  throw new FPLLoginError('Login widget configuration was truncated', 'authorize');
}

function extractResumeState(html: string): string {
  const match = html.match(/<input[^>]+name=["']state["'][^>]+value=["']([^"']+)["']/i)
    ?? html.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']state["']/i);
  if (!match?.[1]) {
    throw new FPLLoginError('Authorize page did not contain the resume state', 'authorize');
  }
  return match[1];
}

interface FlowState {
  id: string;
  interactionId: string;
  connectionId: string;
  capabilityName: string;
  [key: string]: unknown;
}

async function postFlow(
  flow: FlowState,
  bootstrapToken: string,
  parameters: Record<string, string>,
  step: string,
  jar: CookieJar
): Promise<FlowState> {
  const response = await resilientFetch(
    `${AUTH_BASE}/davinci/connections/${flow.connectionId}/capabilities/${flow.capabilityName}`,
    {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bootstrapToken}`,
        Origin: AUTH_BASE,
        Referer: `${AUTH_BASE}/`,
        interactionId: flow.interactionId,
        Cookie: jar.header(),
      },
      body: JSON.stringify({
        id: flow.id,
        eventName: 'continue',
        nextEvent: { constructType: 'skEvent', eventName: 'continue', params: [], eventType: 'post', postProcess: {} },
        parameters,
      }),
    },
    step,
    jar
  );

  const text = await response.text();
  let json: FlowState & { message?: string; code?: string; errorMessage?: string };

  try {
    json = JSON.parse(text);
  } catch {
    throw new FPLLoginError(`${step} returned a non-JSON response (HTTP ${response.status})`, step);
  }

  if (!response.ok) {
    const detail = json.errorMessage ?? json.message ?? `HTTP ${response.status}`;
    throw new FPLLoginError(`${step} failed: ${detail}`, step);
  }

  return json;
}

/**
 * Hand the signed flow response back to the authorization server, which resumes the
 * original OAuth request and redirects to the app with an authorization code.
 * The endpoint takes form-encoded `dvResponse` and the `state` from /as/authorize.
 */
async function resumeAuthorization(
  dvResponse: string,
  resumeState: string,
  oauthState: string,
  jar: CookieJar
): Promise<string> {
  const response = await resilientFetch(
    `${AUTH_BASE}/as/resume`,
    {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: jar.header(),
        Origin: AUTH_BASE,
        Referer: `${AUTH_BASE}/`,
      },
      body: new URLSearchParams({ dvResponse, state: resumeState }).toString(),
      redirect: 'manual',
    },
    'resume',
    jar
  );

  const location = response.headers.get('location');
  if (!location) {
    throw new FPLLoginError(`Resume did not redirect (HTTP ${response.status})`, 'resume');
  }

  const redirected = new URL(location, AUTH_BASE);
  const code = redirected.searchParams.get('code');
  if (!code) {
    const error = redirected.searchParams.get('error');
    const description = redirected.searchParams.get('error_description');
    throw new FPLLoginError(
      `Resume returned no authorization code${description || error ? `: ${(description ?? error)!.slice(0, 200)}` : ''}`,
      'resume'
    );
  }

  if (redirected.searchParams.get('state') !== oauthState) {
    throw new FPLLoginError('OAuth state did not match after login', 'resume');
  }

  return code;
}

async function exchangeCodeForTokens(code: string, verifier: string): Promise<FPLTokens> {
  const response = await resilientFetch(
    `${AUTH_BASE}/as/token`,
    {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: new URL(REDIRECT_URI).origin,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    },
    'token exchange'
  );

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new FPLLoginError(
      `Token exchange failed: ${payload.error_description ?? payload.error ?? `HTTP ${response.status}`}`,
      'token exchange'
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    idToken: payload.id_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
}

/**
 * Sign in with the manager's own email and password, returning OAuth tokens.
 */
export async function loginWithCredentials(email: string, password: string): Promise<FPLTokens> {
  if (!email || !password) {
    throw new FPLLoginError('FPL_EMAIL and FPL_PASSWORD are required for credential login', 'config');
  }

  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  // The callback must return this state; /as/resume uses a separate value embedded
  // in the authorize page.
  const oauthState = randomUUID();

  const authorizeUrl = `${AUTH_BASE}/as/authorize?${new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid profile email offline_access',
    state: oauthState,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    language: 'en',
  })}`;

  const jar = new CookieJar();
  const authorizePage = await resilientFetch(authorizeUrl, { headers: NAVIGATION_HEADERS }, 'authorize', jar);
  const authorizeHtml = await authorizePage.text();
  const widget = extractWidgetProps(authorizeHtml);
  const resumeState = extractResumeState(authorizeHtml);

  const startResponse = await resilientFetch(
    `${AUTH_BASE}/davinci/policy/${widget.policyId}/start`,
    {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${widget.accessToken}`,
        Origin: AUTH_BASE,
        Referer: `${AUTH_BASE}/`,
        Cookie: jar.header(),
      },
      body: JSON.stringify({ parameters: {} }),
    },
    'flow start',
    jar
  );

  if (!startResponse.ok) {
    throw new FPLLoginError(`Could not start the login flow (HTTP ${startResponse.status})`, 'flow start');
  }

  const flow = (await startResponse.json()) as FlowState;

  // The flow opens on a hidden device-signal screen before the credential form.
  const credentialScreen = await postFlow(
    flow,
    widget.accessToken,
    { buttonType: 'form-submit', buttonValue: '', protectsdk: '' },
    'device screen',
    jar
  );

  // Accepted credentials advance to a "Set SSO Cookie" screen, which must be
  // continued once more before the flow reports completion.
  const ssoScreen = await postFlow(
    credentialScreen,
    widget.accessToken,
    { buttonType: 'form-submit', buttonValue: 'SIGNON', username: email, password },
    'credential submit',
    jar
  );

  const completed = (await postFlow(
    ssoScreen,
    widget.accessToken,
    { buttonType: 'form-submit', buttonValue: '' },
    'sso continue',
    jar
  )) as FlowState & { success?: boolean; dvResponse?: string; sessionToken?: string; flowResponseUrl?: string };

  if (!completed.success || !completed.dvResponse) {
    throw new FPLLoginError('Login was not accepted (check FPL_EMAIL and FPL_PASSWORD)', 'credential submit');
  }

  const code = await resumeAuthorization(completed.dvResponse, resumeState, oauthState, jar);
  return exchangeCodeForTokens(code, verifier);
}

export async function refreshAccessToken(refreshToken: string): Promise<FPLTokens> {
  const response = await resilientFetch(
    `${AUTH_BASE}/as/token`,
    {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: AUTH_BASE,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: 'openid profile email offline_access',
      }).toString(),
    },
    'token refresh'
  );

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new FPLLoginError(
      `Token refresh failed: ${payload.error_description ?? payload.error ?? `HTTP ${response.status}`}`,
      'token refresh'
    );
  }

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? refreshToken,
    idToken: payload.id_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
  };
}

// Tokens are cached on disk so restarts near a deadline do not need a fresh login.
export function loadStoredTokens(): FPLTokens | null {
  try {
    const stored = JSON.parse(readFileSync(SESSION_FILE, 'utf8')) as FPLTokens;
    return typeof stored.accessToken === 'string' && typeof stored.expiresAt === 'number' ? stored : null;
  } catch {
    return null;
  }
}

export function saveTokens(tokens: FPLTokens): void {
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(tokens, null, 2));
  chmodSync(SESSION_FILE, 0o600);
}

/**
 * Return a usable access token, refreshing or re-authenticating as needed.
 * A token within two minutes of expiry is treated as already expired.
 */
export async function getValidTokens(options: { email?: string; password?: string } = {}): Promise<FPLTokens | null> {
  const stored = loadStoredTokens();
  if (stored && stored.expiresAt - Date.now() > 120_000) return stored;

  if (stored?.refreshToken) {
    try {
      const refreshed = await refreshAccessToken(stored.refreshToken);
      saveTokens(refreshed);
      return refreshed;
    } catch {
      // Fall through to a full login.
    }
  }

  const email = options.email ?? process.env.FPL_EMAIL;
  const password = options.password ?? process.env.FPL_PASSWORD;
  if (!email || !password) return null;

  const tokens = await loginWithCredentials(email, password);
  saveTokens(tokens);
  return tokens;
}
