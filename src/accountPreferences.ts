export const ACCOUNT_PROMPT_PREFERENCE_KEY = "crowflix:account-prompt:v1";

type AccountPromptPreferenceV1 = {
  version: 1;
  suppressed: boolean;
};

export type AccountPromptPreference = {
  suppressed: boolean;
  error: string | null;
};

const DEFAULT_PREFERENCE: AccountPromptPreference = {
  suppressed: false,
  error: null,
};

function isPreferenceV1(value: unknown): value is AccountPromptPreferenceV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && typeof record.suppressed === "boolean";
}

export function loadAccountPromptPreference(
  storage: Pick<Storage, "getItem">,
): AccountPromptPreference {
  let raw: string | null;
  try {
    raw = storage.getItem(ACCOUNT_PROMPT_PREFERENCE_KEY);
  } catch {
    return {
      suppressed: false,
      error: "CrowFlix could not read the account reminder setting. Anonymous viewing still works normally.",
    };
  }
  if (raw === null) return DEFAULT_PREFERENCE;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPreferenceV1(parsed)) {
      return {
        suppressed: false,
        error: "CrowFlix ignored an invalid account reminder setting.",
      };
    }
    return { suppressed: parsed.suppressed, error: null };
  } catch {
    return {
      suppressed: false,
      error: "CrowFlix ignored an invalid account reminder setting.",
    };
  }
}

export function saveAccountPromptPreference(
  storage: Pick<Storage, "setItem">,
  suppressed: boolean,
): string | null {
  try {
    const value: AccountPromptPreferenceV1 = { version: 1, suppressed };
    storage.setItem(ACCOUNT_PROMPT_PREFERENCE_KEY, JSON.stringify(value));
    return null;
  } catch {
    return "CrowFlix could not save the account reminder setting. Anonymous viewing still works normally.";
  }
}

export function clearAccountPromptPreference(
  storage: Pick<Storage, "removeItem">,
): string | null {
  try {
    storage.removeItem(ACCOUNT_PROMPT_PREFERENCE_KEY);
    return null;
  } catch {
    return "CrowFlix could not reset the account reminder setting. Anonymous viewing still works normally.";
  }
}
