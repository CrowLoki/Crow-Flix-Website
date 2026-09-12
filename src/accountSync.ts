export const ACCOUNT_FAVOURITES_VERSION = 1 as const;
export const MAX_ACCOUNT_FAVOURITES = 20_000;
export const MAX_CHANNEL_KEY_LENGTH = 4_096;

export type AccountSession = {
  userId: string;
  displayName: string | null;
};

export type AccountFavouritesRecord = {
  version: typeof ACCOUNT_FAVOURITES_VERSION;
  revision: number;
  favourites: string[];
};

export type AccountFavouritesWrite = {
  expectedRevision: number;
  favourites: string[];
};

export interface AccountSyncAdapter {
  getSession(signal?: AbortSignal): Promise<AccountSession | null>;
  beginSignIn(returnTo: string): Promise<void>;
  signOut(): Promise<void>;
  readFavourites(signal?: AbortSignal): Promise<AccountFavouritesRecord>;
  writeFavourites(input: AccountFavouritesWrite): Promise<AccountFavouritesRecord>;
  exportAccountData(): Promise<Blob>;
  deleteAccount(): Promise<void>;
}

function collectAccountFavouriteKeys(
  values: unknown[],
  rejectOverflow: boolean,
): string[] | null {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!Array.isArray(value)) continue;
    for (const candidate of value) {
      if (
        typeof candidate !== "string"
        || candidate.length === 0
        || candidate.length > MAX_CHANNEL_KEY_LENGTH
        || seen.has(candidate)
      ) continue;
      if (result.length >= MAX_ACCOUNT_FAVOURITES) {
        return rejectOverflow ? null : result;
      }
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

export function normalizeAccountFavouriteKeys(value: unknown): string[] {
  return collectAccountFavouriteKeys([value], false) || [];
}

export function readAccountFavouritesRecord(
  value: unknown,
): AccountFavouritesRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== ACCOUNT_FAVOURITES_VERSION
    || !Number.isSafeInteger(record.revision)
    || (record.revision as number) < 0
    || !Array.isArray(record.favourites)
  ) return null;
  const favourites = collectAccountFavouriteKeys([record.favourites], true);
  if (!favourites) return null;
  return {
    version: ACCOUNT_FAVOURITES_VERSION,
    revision: record.revision as number,
    favourites,
  };
}

export function mergeAccountFavouriteKeys(
  local: unknown,
  remote: unknown,
): string[] | null {
  return collectAccountFavouriteKeys([local, remote], true);
}

export function createAccountFavouritesWrite(
  favourites: unknown,
  expectedRevision: number,
): AccountFavouritesWrite | null {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
  const normalizedFavourites = collectAccountFavouriteKeys([favourites], true);
  if (!normalizedFavourites) return null;
  return {
    expectedRevision,
    favourites: normalizedFavourites,
  };
}
