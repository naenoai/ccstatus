// Credential acquisition. This module must not import `vscode` — it is loaded
// directly by the unit tests, which run in a plain Node process with no editor
// host. Where credentials live is platform-specific; what they contain is not,
// so every caller downstream sees the same shape regardless of source.

export interface OAuthCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

export interface CredentialSources {
  platform: string;
  keychain: () => string;
  readFile: () => string;
}

// Claude Code stores the login Keychain entry under this service name.
export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export function readCredentials(sources: CredentialSources): OAuthCredentials | null {
  if (sources.platform === 'darwin') {
    return parse(sources.keychain) ?? parse(sources.readFile);
  }
  return parse(sources.readFile);
}

// A source counts as having credentials only when it yields an access token.
// An entry that parses but carries no token is treated as absent, so it cannot
// shadow a later source that does have one.
function parse(read: () => string): OAuthCredentials | null {
  try {
    const raw = read();
    if (!raw) { return null; }
    const creds = JSON.parse(raw)?.claudeAiOauth as OAuthCredentials | undefined;
    return creds?.accessToken ? creds : null;
  } catch { return null; }
}
