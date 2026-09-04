// The loopback sign-in `roze auth` runs, the owner-only token file it writes, and the refresh every later
// read passes through. It produces the token client.ts spends; it never calls the Gmail API itself.

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { z } from "zod";
import { loadEnvironmentFile, readJson, writeFileAtomically } from "../shared/atomicFiles.js";
import { describeHttpFailure, type FetchLike } from "./http.js";

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_AUTH_URI = "https://accounts.google.com/o/oauth2/auth";
/** Refreshed a little early, so a long fetch cannot expire mid-flight. */
const REFRESH_EARLY_MS = 3 * 60_000 + 45_000;
// The project's public OAuth client and the proxy that holds its secret, so a fresh clone signs in with only an
// OpenAI key in .env. A desktop OAuth client's secret is not truly secret, but handing it out in a .env is still
// worse than a proxy that only ever exchanges codes for this one client id. Setting GOOGLE_CLIENT_SECRET switches
// to the direct exchange with Google.
const DEFAULT_CLIENT_ID = "906042128148-0gkk07sr658itahv17ld9pm740e3n3gf.apps.googleusercontent.com";
const DEFAULT_TOKEN_PROXY = "https://roze-token-proxy.kaneki.workers.dev";

const credentialsSchema = z
  .object({
    token: z.string().min(1),
    refresh_token: z.string(),
    token_uri: z.string().min(1),
    client_id: z.string().min(1),
    client_secret: z.string(),
    /** Set, with an empty client_secret, when the proxy exchanged the code and must refresh the token too. */
    token_proxy: z.string().min(1).optional(),
    scopes: z.array(z.string()),
    expiry: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  })
  // google-auth writes extra fields (account, universe_domain); its token files must still load
  .loose()
  .refine((value) => value.client_secret.length > 0 || value.token_proxy !== undefined);
const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
});
export type GoogleCredentials = z.output<typeof credentialsSchema>;

interface CredentialOptions {
  tokenPath?: string;
  fetch?: FetchLike;
  now?: () => number;
}
interface SignInOptions extends CredentialOptions {
  openBrowser?: (url: string) => void | Promise<void>;
  timeoutMs?: number;
}

const resolveTokenPath = (path?: string): string => resolve(path ?? ".token.json");

const saveCredentials = (path: string, value: GoogleCredentials): void =>
  writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`, 0o600);

const expiresAt = (now: number, seconds: number): string => new Date(now + seconds * 1_000).toISOString();

/** Where token requests go: straight to Google with the secret, or through the proxy that holds it. */
interface TokenExchange {
  clientId: string;
  clientSecret: string;
  tokenProxy?: string;
}

function readClientConfiguration(): TokenExchange {
  loadEnvironmentFile();
  const clientId = process.env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? "";
  // An explicitly empty ROZE_TOKEN_PROXY opts out of the default proxy.
  const tokenProxy = process.env.ROZE_TOKEN_PROXY ?? DEFAULT_TOKEN_PROXY;
  if (clientSecret) return { clientId, clientSecret };
  if (tokenProxy) return { clientId, clientSecret: "", tokenProxy };
  throw new Error(
    "Set GOOGLE_CLIENT_SECRET (a Google OAuth 'Desktop app' client) or ROZE_TOKEN_PROXY (a token proxy URL) " +
      "in .env.",
  );
}

const exchangeFor = (credentials: GoogleCredentials): TokenExchange => ({
  clientId: credentials.client_id,
  clientSecret: credentials.client_secret,
  tokenProxy: credentials.token_proxy,
});

async function requestTokens(
  exchange: TokenExchange,
  grant: Record<string, string>,
  fetcher: FetchLike,
  action: string,
): Promise<z.output<typeof tokenSchema>> {
  // The proxy adds the client id and secret itself and answers with Google's document and status.
  const response = exchange.clientSecret
    ? await fetcher(GOOGLE_TOKEN_URI, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: exchange.clientId, client_secret: exchange.clientSecret, ...grant }),
      })
    : await fetcher(`${exchange.tokenProxy}/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(grant),
      });
  if (!response.ok) throw new Error((await describeHttpFailure(response, action)).message);
  try {
    return tokenSchema.parse(await response.json());
  } catch (error) {
    throw new Error(`${action} returned an invalid token document`, { cause: error });
  }
}

async function refreshAccessToken(
  credentials: GoogleCredentials,
  options: Pick<CredentialOptions, "fetch" | "now"> = {},
): Promise<GoogleCredentials> {
  if (!credentials.refresh_token)
    throw new Error("Stored Google credentials have no refresh token. Run `roze auth` again.");
  const now = options.now?.() ?? Date.now();
  const tokens = await requestTokens(
    exchangeFor(credentials),
    { refresh_token: credentials.refresh_token, grant_type: "refresh_token" },
    options.fetch ?? globalThis.fetch,
    "Google token refresh",
  );
  return {
    ...credentials,
    token: tokens.access_token,
    token_uri: GOOGLE_TOKEN_URI,
    expiry: expiresAt(now, tokens.expires_in),
  };
}

export async function loadSavedCredentials(options: CredentialOptions = {}): Promise<GoogleCredentials> {
  const path = resolveTokenPath(options.tokenPath);
  const stored = readJson(path);
  if (stored === undefined) throw new Error("Not signed in. Run `roze auth` first.");
  const parsed = credentialsSchema.safeParse(stored);
  if (!parsed.success || !parsed.data.scopes.includes(GMAIL_SCOPE))
    throw new Error("Stored token is invalid. Run `roze auth` again.");
  const now = options.now?.() ?? Date.now();
  if (Date.parse(parsed.data.expiry) - REFRESH_EARLY_MS > now) return parsed.data;
  const refreshed = await refreshAccessToken(parsed.data, options);
  saveCredentials(path, refreshed);
  return refreshed;
}

/** What the client spends: a token that is renewed a little early, and again after Gmail answers 401. */
export interface AccessTokenSource {
  token(): Promise<string>;
  /** The next `token()` refreshes even though the saved expiry still looks fine. */
  invalidate(): void;
}

/**
 * A build outlives a Google access token (sixty minutes, not extendable) several times over, so the client
 * asks this source before every request instead of holding one token for its whole life. A renewal is shared
 * across the workers that hit the boundary together, and the renewed token is saved for the next command.
 */
export function createTokenSource(options: CredentialOptions = {}): AccessTokenSource {
  let current: GoogleCredentials | undefined;
  let stale = false;
  let renewal: Promise<GoogleCredentials> | undefined;
  const renew = (): Promise<GoogleCredentials> =>
    (renewal ??= (async () => {
      try {
        if (stale && current) {
          const refreshed = await refreshAccessToken(current, options);
          saveCredentials(resolveTokenPath(options.tokenPath), refreshed);
          return refreshed;
        }
        // Re-reading the file also picks up a token another roze process renewed meanwhile.
        return await loadSavedCredentials(options);
      } finally {
        renewal = undefined;
      }
    })());
  return {
    async token() {
      const now = options.now?.() ?? Date.now();
      if (current && !stale && Date.parse(current.expiry) - REFRESH_EARLY_MS > now) return current.token;
      current = await renew();
      stale = false;
      return current.token;
    },
    invalidate() {
      stale = true;
    },
  };
}

/** Sign-in and tests spend a token as-is; nothing renews it. */
export const staticTokenSource = (token: string): AccessTokenSource => ({
  token: async () => token,
  invalidate: () => undefined,
});

/** `cmd /c start` splits a URL at every `&`, dropping response_type and breaking sign-in on Windows. */
function browserCommand(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") return { command: "open", args: [url] };
  if (process.platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  return { command: "xdg-open", args: [url] };
}

function openBrowser(url: string): void {
  const { command, args } = browserCommand(url);
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  // A headless machine has no opener and the printed URL is the fallback, so a spawn failure must not
  // reject and abort sign-in.
  child.once("error", () => undefined);
  child.unref();
  process.stderr.write(`Opening Google sign-in. If no browser window appears, paste this URL into one:\n${url}\n`);
}

interface CallbackServer {
  redirectUri: string;
  code: Promise<string>;
  close(): Promise<void>;
}
type CallbackResult = { code: string } | { error: Error };

/**
 * The browser holds its connection open after the redirect and `server.close()` waits for every one to
 * end, so undropped they hang the process after a successful sign-in until the browser gives up.
 */
const closeAndDropConnections = (server: Server): Promise<void> =>
  new Promise((accept) => {
    server.closeAllConnections();
    server.close(() => accept());
  });

function readCallbackResult(url: URL, expectedState: string): CallbackResult {
  if (url.searchParams.get("state") !== expectedState)
    return { error: new Error("Google OAuth callback had an invalid state") };
  const providerError = url.searchParams.get("error");
  if (providerError) return { error: new Error(`Google authorization failed: ${providerError}`) };
  const code = url.searchParams.get("code");
  if (!code) return { error: new Error("Google OAuth callback did not include an authorization code") };
  return { code };
}

async function startCallbackServer(state: string, timeoutMs: number): Promise<CallbackServer> {
  let settle!: (result: CallbackResult) => void;
  let settled = false;
  const code = new Promise<string>((accept, reject) => {
    settle = (result) => {
      // Only the first answer counts: a stray second request, or the timeout, must not settle twice.
      if (settled) return;
      settled = true;
      if ("error" in result) reject(result.error);
      else accept(result.code);
    };
  });
  let redirectUri = "http://127.0.0.1";
  const server = createServer((request, response) => {
    const result = readCallbackResult(new URL(request.url ?? "/", redirectUri), state);
    const failed = "error" in result;
    response.writeHead(failed ? 400 : 200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<p>Google sign-in ${failed ? "failed" : "complete"}. You can close this window.</p>`);
    settle(result);
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      accept();
    });
  });
  redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  const timeout = setTimeout(() => settle({ error: new Error("Timed out waiting for Google sign-in") }), timeoutMs);
  timeout.unref();
  return {
    redirectUri,
    code,
    close: async () => {
      clearTimeout(timeout);
      await closeAndDropConnections(server);
    },
  };
}

function buildAuthorizationUrl(clientId: string, redirectUri: string, state: string, verifier: string): string {
  const url = new URL(GOOGLE_AUTH_URI);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GMAIL_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export async function signInWithGoogle(options: SignInOptions = {}): Promise<GoogleCredentials> {
  const exchange = readClientConfiguration();
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const callback = await startCallbackServer(state, options.timeoutMs ?? 5 * 60_000);
  try {
    await (options.openBrowser ?? openBrowser)(
      buildAuthorizationUrl(exchange.clientId, callback.redirectUri, state, verifier),
    );
    const code = await callback.code;
    const tokens = await requestTokens(
      exchange,
      { code, redirect_uri: callback.redirectUri, grant_type: "authorization_code", code_verifier: verifier },
      options.fetch ?? globalThis.fetch,
      "Google authorization-code exchange",
    );
    if (!tokens.refresh_token)
      throw new Error("Google did not return a refresh token. Remove this app's access and run `roze auth` again.");
    const credentials: GoogleCredentials = {
      token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_uri: GOOGLE_TOKEN_URI,
      client_id: exchange.clientId,
      client_secret: exchange.clientSecret,
      ...(exchange.tokenProxy === undefined ? {} : { token_proxy: exchange.tokenProxy }),
      scopes: [GMAIL_SCOPE],
      expiry: expiresAt(options.now?.() ?? Date.now(), tokens.expires_in),
    };
    saveCredentials(resolveTokenPath(options.tokenPath), credentials);
    return credentials;
  } finally {
    await callback.close();
  }
}
