// Resolve localStorage only inside each operation so callers can catch both
// denied getter access and failures from the storage methods themselves.
export const browserStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem(key) {
    return globalThis.localStorage.getItem(key);
  },
  setItem(key, value) {
    globalThis.localStorage.setItem(key, value);
  },
  removeItem(key) {
    globalThis.localStorage.removeItem(key);
  },
};

// Noncritical preferences may remain in React state when persistence fails.
// Explicit save flows should use browserStorage and report their own errors.
export function saveBrowserValue(key: string, value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return false;
    browserStorage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
}
