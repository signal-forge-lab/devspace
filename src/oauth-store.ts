import { randomUUID } from "node:crypto";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { openDatabase, type DatabaseHandle } from "./db/client.js";

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

export interface OAuthStaticClientConfig {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  allowedScopes?: string[];
  disabled?: boolean;
}

export interface OAuthDiagnosticEvent extends Record<string, unknown> {
  event: string;
  clientId?: string;
  clientName?: string;
  redirectUri?: string;
  redirectUris?: string[];
  allowedRedirectUris?: string[];
  scope?: string;
  status?: string;
  reason?: string;
  tokenEndpointAuthMethod?: string;
  grantTypes?: string[];
  responseTypes?: string[];
}

export type OAuthDiagnosticLogger = (event: OAuthDiagnosticEvent) => void;

export interface OAuthClientsStoreOptions {
  staticClients?: OAuthStaticClientConfig[];
  diagnosticLogger?: OAuthDiagnosticLogger;
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }

  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.includes(parsed.hostname);
}

export class SqliteOAuthStore {
  private readonly database: DatabaseHandle;

  constructor(stateDir: string) {
    this.database = openDatabase(stateDir);
    this.deleteExpiredTokens(Math.floor(Date.now() / 1000));
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.database.sqlite
      .prepare("select client_json from oauth_clients where client_id = ?")
      .get(clientId) as { client_json: string } | undefined;

    return row ? (JSON.parse(row.client_json) as OAuthClientInformationFull) : undefined;
  }

  upsertClient(client: OAuthClientInformationFull): void {
    const issuedAt = client.client_id_issued_at ?? Math.floor(Date.now() / 1000);
    this.database.sqlite
      .prepare(
        `insert into oauth_clients (client_id, client_json, issued_at)
         values (?, ?, ?)
         on conflict(client_id) do update set
           client_json = excluded.client_json,
           issued_at = excluded.issued_at`,
      )
      .run(client.client_id, JSON.stringify(client), issuedAt);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): OAuthClientInformationFull {
    if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
      throw new InvalidRequestError("Client redirect_uri is not allowed for this DevSpace server");
    }

    const now = Math.floor(Date.now() / 1000);
    const registered: OAuthClientInformationFull = {
      ...client,
      client_id: `devspace-${randomUUID()}`,
      client_id_issued_at: now,
      token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
      grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
      response_types: client.response_types ?? ["code"],
    };

    this.database.sqlite
      .prepare("insert into oauth_clients (client_id, client_json, issued_at) values (?, ?, ?)")
      .run(registered.client_id, JSON.stringify(registered), now);

    return registered;
  }

  saveAccessToken(tokenHash: string, record: PersistedAccessTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_access_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  getAccessToken(tokenHash: string): PersistedAccessTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_access_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToAccessTokenRecord(row) : undefined;
  }

  deleteAccessToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where token_hash = ?").run(tokenHash);
  }

  saveRefreshToken(tokenHash: string, record: PersistedRefreshTokenRecord): void {
    this.database.sqlite
      .prepare(
        `insert into oauth_refresh_tokens (token_hash, client_id, scopes_json, expires_at, resource)
         values (?, ?, ?, ?, ?)
         on conflict(token_hash) do update set
           client_id = excluded.client_id,
           scopes_json = excluded.scopes_json,
           expires_at = excluded.expires_at,
           resource = excluded.resource`,
      )
      .run(
        tokenHash,
        record.clientId,
        JSON.stringify(record.scopes),
        record.expiresAt,
        record.resource ?? null,
      );
  }

  saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): boolean {
    const save = this.database.sqlite.transaction(() => {
      if (consumedRefreshTokenHash) {
        const result = this.database.sqlite
          .prepare("delete from oauth_refresh_tokens where token_hash = ?")
          .run(consumedRefreshTokenHash);
        if (result.changes !== 1) return false;
      }

      this.saveAccessToken(pair.accessTokenHash, pair.accessToken);
      this.saveRefreshToken(pair.refreshTokenHash, pair.refreshToken);
      return true;
    });

    return save.immediate();
  }

  getRefreshToken(tokenHash: string): PersistedRefreshTokenRecord | undefined {
    const row = this.database.sqlite
      .prepare(
        "select client_id, scopes_json, expires_at, resource from oauth_refresh_tokens where token_hash = ?",
      )
      .get(tokenHash) as
      | {
          client_id: string;
          scopes_json: string;
          expires_at: number;
          resource: string | null;
        }
      | undefined;

    return row ? rowToRefreshTokenRecord(row) : undefined;
  }

  deleteRefreshToken(tokenHash: string): void {
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where token_hash = ?").run(tokenHash);
  }

  close(): void {
    this.database.close();
  }

  private deleteExpiredTokens(nowSeconds: number): void {
    this.database.sqlite.prepare("delete from oauth_access_tokens where expires_at < ?").run(nowSeconds);
    this.database.sqlite.prepare("delete from oauth_refresh_tokens where expires_at < ?").run(nowSeconds);
  }
}

export class SqliteOAuthClientsStore implements OAuthRegisteredClientsStore {
  private readonly staticClients: Map<string, OAuthStaticClientConfig>;
  private readonly diagnosticLogger?: OAuthDiagnosticLogger;

  constructor(
    private readonly store: SqliteOAuthStore,
    private readonly allowedRedirectHosts: string[],
    options: OAuthClientsStoreOptions = {},
  ) {
    this.staticClients = new Map((options.staticClients ?? []).map((client) => [client.clientId, client]));
    this.diagnosticLogger = options.diagnosticLogger;
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const staticClient = this.staticClients.get(clientId);
    if (staticClient) {
      if (staticClient.disabled) {
        this.logDiagnostic({ event: "oauth_static_client_lookup", clientId, status: "disabled" });
        return undefined;
      }
      this.logDiagnostic({
        event: "oauth_static_client_lookup",
        clientId,
        clientName: staticClient.clientName,
        redirectUris: staticClient.redirectUris,
        scope: staticClient.allowedScopes?.join(" "),
        status: "ok",
      });
      const clientInfo = staticClientInformation(staticClient);
      this.store.upsertClient(clientInfo);
      return clientInfo;
    }

    const stored = this.store.getClient(clientId);
    this.logDiagnostic({ event: "oauth_client_lookup", clientId, status: stored ? "stored" : "miss" });
    return stored;
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): OAuthClientInformationFull {
    this.logDiagnostic({
      event: "oauth_client_registration_request",
      clientName: client.client_name,
      redirectUris: client.redirect_uris.map(String),
      scope: client.scope,
      tokenEndpointAuthMethod: client.token_endpoint_auth_method,
      grantTypes: client.grant_types,
      responseTypes: client.response_types,
      status: "received",
    });
    try {
      const registered = this.store.registerClient(client, this.allowedRedirectHosts);
      this.logDiagnostic({
        event: "oauth_client_registration_result",
        clientId: registered.client_id,
        clientName: registered.client_name,
        redirectUris: registered.redirect_uris.map(String),
        scope: registered.scope,
        tokenEndpointAuthMethod: registered.token_endpoint_auth_method,
        status: "registered",
      });
      return registered;
    } catch (error) {
      this.logDiagnostic({
        event: "oauth_client_registration_result",
        clientName: client.client_name,
        redirectUris: client.redirect_uris.map(String),
        scope: client.scope,
        tokenEndpointAuthMethod: client.token_endpoint_auth_method,
        status: "rejected",
        reason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private logDiagnostic(event: OAuthDiagnosticEvent): void {
    this.diagnosticLogger?.(event);
  }
}

function staticClientInformation(client: OAuthStaticClientConfig): OAuthClientInformationFull {
  return {
    client_id: client.clientId,
    client_id_issued_at: 0,
    client_name: client.clientName ?? client.clientId,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: client.allowedScopes?.join(" "),
  };
}

function rowToAccessTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedAccessTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}

function rowToRefreshTokenRecord(row: {
  client_id: string;
  scopes_json: string;
  expires_at: number;
  resource: string | null;
}): PersistedRefreshTokenRecord {
  return {
    clientId: row.client_id,
    scopes: JSON.parse(row.scopes_json) as string[],
    expiresAt: row.expires_at,
    resource: row.resource ?? undefined,
  };
}
