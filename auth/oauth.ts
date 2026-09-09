import crypto from "crypto";

// ── Types ────────────────────────────────────────────────────

export interface OAuthProfile {
  provider: "google" | "discord";
  providerUserId: string;
  email: string;
  /**
   * Whether the *provider* says it has confirmed this address belongs to the
   * account. Load-bearing: the email is what an OAuth identity is matched to a
   * local account by, and Discord in particular lets anyone type an arbitrary
   * unconfirmed address onto a throwaway account. Trusting that would make
   * "sign in with Discord" a way to log into any Streamio account whose email
   * you know. See `AccountService.upsertOAuthUser`.
   */
  emailVerified: boolean;
  displayName: string;
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string;
  tokenExp?: Date;
}

interface ProviderConfig {
  authUrl: string;
  tokenUrl: string;
  userUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

// ── Provider configs ─────────────────────────────────────────

function getConfig(provider: OAuthProvider): ProviderConfig {
  const redirect = redirectUri(provider);

  switch (provider) {
    case "google":
      return {
        authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        userUrl: "https://www.googleapis.com/oauth2/v3/userinfo",
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
        scopes: ["openid", "email", "profile"],
      };
    case "discord":
      return {
        authUrl: "https://discord.com/api/oauth2/authorize",
        tokenUrl: "https://discord.com/api/oauth2/token",
        userUrl: "https://discord.com/api/users/@me",
        clientId: process.env.DISCORD_CLIENT_ID!,
        clientSecret: process.env.DISCORD_CLIENT_SECRET!,
        scopes: ["identify", "email"],
      };
  }
}

export type OAuthProvider = "google" | "discord";

export function redirectUri(provider: OAuthProvider): string {
  const base = process.env.APP_URL ?? "http://localhost:3003";
  return `${base}/api/auth/${provider}/callback`;
}

// ── Build authorization URL ──────────────────────────────────

export function buildAuthUrl(provider: OAuthProvider, state: string): string {
  const cfg = getConfig(provider);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(provider),
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state,
    ...(provider === "google" ? {} : {}),
  });
  return `${cfg.authUrl}?${params}`;
}

// ── Exchange code for tokens ─────────────────────────────────

async function exchangeCode(
  provider: OAuthProvider,
  code: string,
): Promise<{ accessToken: string; refreshToken?: string; expiresIn?: number }> {
  const cfg = getConfig(provider);

  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: redirectUri(provider),
    grant_type: "authorization_code",
    code,
  });

  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[${provider}] token exchange failed: ${text}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

// ── Fetch user profile ───────────────────────────────────────

async function fetchProfile(
  provider: OAuthProvider,
  accessToken: string,
  refreshToken?: string,
  expiresIn?: number,
): Promise<OAuthProfile> {
  const cfg = getConfig(provider);

  const res = await fetch(cfg.userUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`[${provider}] failed to fetch user profile`);
  }

  const data = await res.json();
  const tokenExp = expiresIn
    ? new Date(Date.now() + expiresIn * 1000)
    : undefined;

  switch (provider) {
    case "google":
      return {
        provider,
        providerUserId: data.sub,
        email: data.email,
        // Google sends this as a real boolean on the v3 userinfo endpoint, but
        // has historically sent the string "true" on others — accept both, and
        // nothing else.
        emailVerified: data.email_verified === true || data.email_verified === "true",
        displayName: data.name ?? data.email,
        avatarUrl: data.picture,
        accessToken,
        refreshToken,
        tokenExp,
      };

    case "discord":
      return {
        provider,
        providerUserId: data.id,
        email: data.email,
        emailVerified: data.verified === true,
        displayName: data.global_name ?? data.username,
        avatarUrl: data.avatar
          ? `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`
          : undefined,
        accessToken,
        refreshToken,
        tokenExp,
      };
  }
}

// ── Public: handle callback ──────────────────────────────────

export async function handleOAuthCallback(
  provider: OAuthProvider,
  code: string,
): Promise<OAuthProfile> {
  const { accessToken, refreshToken, expiresIn } = await exchangeCode(
    provider,
    code,
  );
  return fetchProfile(provider, accessToken, refreshToken, expiresIn);
}

// ── CSRF state helpers ───────────────────────────────────────

export function generateState(): string {
  return crypto.randomBytes(16).toString("hex");
}
