import { describe, expect, it } from "vitest";
import {
  ACCOUNT_FAVOURITES_VERSION,
  MAX_ACCOUNT_FAVOURITES,
  MAX_CHANNEL_KEY_LENGTH,
  createAccountFavouritesWrite,
  mergeAccountFavouriteKeys,
  normalizeAccountFavouriteKeys,
  readAccountFavouritesRecord,
} from "./accountSync";

describe("CrowFlix account favourites contract", () => {
  it("keeps valid unknown channel identities in stable order", () => {
    expect(normalizeAccountFavouriteKeys([
      "known-channel",
      "future-provider|unknown-channel",
      "known-channel",
      7,
      "",
    ])).toEqual(["known-channel", "future-provider|unknown-channel"]);
  });

  it("bounds key size and total account payload", () => {
    const keys = Array.from({ length: MAX_ACCOUNT_FAVOURITES + 4 }, (_, index) => `channel-${index}`);
    keys.splice(2, 0, "x".repeat(MAX_CHANNEL_KEY_LENGTH + 1));
    const result = normalizeAccountFavouriteKeys(keys);
    expect(result).toHaveLength(MAX_ACCOUNT_FAVOURITES);
    expect(result).not.toContain("x".repeat(MAX_CHANNEL_KEY_LENGTH + 1));
  });

  it("merges local first, then remote extras, without deleting either side", () => {
    expect(mergeAccountFavouriteKeys(
      ["local-a", "shared", "local-b"],
      ["remote-a", "shared", "remote-b"],
    )).toEqual(["local-a", "shared", "local-b", "remote-a", "remote-b"]);
  });

  it("rejects a merge rather than deleting either side when the union is too large", () => {
    const local = Array.from({ length: MAX_ACCOUNT_FAVOURITES }, (_, index) => `local-${index}`);
    expect(mergeAccountFavouriteKeys(local, ["remote-only"])).toBeNull();
  });

  it("reads only the versioned revision contract", () => {
    expect(readAccountFavouritesRecord({
      version: ACCOUNT_FAVOURITES_VERSION,
      revision: 4,
      favourites: ["one", "one", "two"],
    })).toEqual({
      version: ACCOUNT_FAVOURITES_VERSION,
      revision: 4,
      favourites: ["one", "two"],
    });
    expect(readAccountFavouritesRecord({ version: 2, revision: 4, favourites: [] })).toBeNull();
    expect(readAccountFavouritesRecord({ version: 1, revision: -1, favourites: [] })).toBeNull();
    expect(readAccountFavouritesRecord({ version: 1, revision: 1.5, favourites: [] })).toBeNull();
    expect(readAccountFavouritesRecord({
      version: ACCOUNT_FAVOURITES_VERSION,
      revision: 1,
      favourites: Array.from({ length: MAX_ACCOUNT_FAVOURITES + 1 }, (_, index) => `channel-${index}`),
    })).toBeNull();
  });

  it("creates an optimistic-concurrency write and rejects invalid revisions", () => {
    expect(createAccountFavouritesWrite(["one", "one", "two"], 8)).toEqual({
      expectedRevision: 8,
      favourites: ["one", "two"],
    });
    expect(createAccountFavouritesWrite(["one"], -1)).toBeNull();
    expect(createAccountFavouritesWrite(["one"], Number.NaN)).toBeNull();
    expect(createAccountFavouritesWrite(
      Array.from({ length: MAX_ACCOUNT_FAVOURITES + 1 }, (_, index) => `channel-${index}`),
      0,
    )).toBeNull();
  });
});
