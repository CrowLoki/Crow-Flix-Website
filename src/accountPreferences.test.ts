import { describe, expect, it } from "vitest";
import {
  ACCOUNT_PROMPT_PREFERENCE_KEY,
  clearAccountPromptPreference,
  loadAccountPromptPreference,
  saveAccountPromptPreference,
} from "./accountPreferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    snapshot: () => Object.fromEntries(values),
  };
}

describe("CrowFlix account reminder preference", () => {
  it("offers the optional reminder when no preference exists", () => {
    expect(loadAccountPromptPreference(memoryStorage())).toEqual({
      suppressed: false,
      error: null,
    });
  });

  it("persists and reloads an explicit do-not-show choice", () => {
    const storage = memoryStorage({
      "crowflix:favourites": JSON.stringify(["keep-this-channel"]),
      "crowflix:recent": JSON.stringify(["keep-this-recent-channel"]),
    });
    expect(saveAccountPromptPreference(storage, true)).toBeNull();
    expect(loadAccountPromptPreference(storage)).toEqual({
      suppressed: true,
      error: null,
    });
    expect(storage.snapshot()).toEqual({
      "crowflix:favourites": JSON.stringify(["keep-this-channel"]),
      "crowflix:recent": JSON.stringify(["keep-this-recent-channel"]),
      [ACCOUNT_PROMPT_PREFERENCE_KEY]: JSON.stringify({ version: 1, suppressed: true }),
    });
  });

  it("clears only its own key so the reminder can be restored", () => {
    const storage = memoryStorage({
      [ACCOUNT_PROMPT_PREFERENCE_KEY]: JSON.stringify({ version: 1, suppressed: true }),
      "crowflix:web-destinations:v1": "keep-web-library",
    });
    expect(clearAccountPromptPreference(storage)).toBeNull();
    expect(storage.snapshot()).toEqual({
      "crowflix:web-destinations:v1": "keep-web-library",
    });
    expect(loadAccountPromptPreference(storage).suppressed).toBe(false);
  });

  it.each([
    "not json",
    JSON.stringify({ version: 2, suppressed: true }),
    JSON.stringify({ version: 1, suppressed: "yes" }),
    JSON.stringify([1, true]),
  ])("ignores malformed or unknown stored data: %s", (raw) => {
    const result = loadAccountPromptPreference(memoryStorage({
      [ACCOUNT_PROMPT_PREFERENCE_KEY]: raw,
    }));
    expect(result.suppressed).toBe(false);
    expect(result.error).toMatch(/ignored an invalid/);
  });

  it("keeps anonymous use available when browser storage throws", () => {
    expect(loadAccountPromptPreference({
      getItem: () => { throw new Error("blocked"); },
    })).toEqual({
      suppressed: false,
      error: expect.stringContaining("Anonymous viewing still works"),
    });
    expect(saveAccountPromptPreference({
      setItem: () => { throw new Error("quota"); },
    }, true)).toMatch(/Anonymous viewing still works/);
    expect(clearAccountPromptPreference({
      removeItem: () => { throw new Error("blocked"); },
    })).toMatch(/Anonymous viewing still works/);
  });
});
