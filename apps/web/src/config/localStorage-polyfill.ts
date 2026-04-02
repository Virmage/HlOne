// This file MUST be imported before any wagmi/rainbowkit code.
// It patches localStorage in sandboxed browsers where localStorage exists
// but its methods aren't real functions.

if (typeof window !== "undefined") {
  let needsPatch = false;
  try {
    if (typeof window.localStorage === "undefined") {
      needsPatch = true;
    } else if (typeof window.localStorage.getItem !== "function") {
      needsPatch = true;
    } else {
      window.localStorage.setItem("__ls_test__", "1");
      window.localStorage.removeItem("__ls_test__");
    }
  } catch {
    needsPatch = true;
  }

  if (needsPatch) {
    const store: Record<string, string> = {};
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
        setItem: (k: string, v: string) => { store[k] = String(v); },
        removeItem: (k: string) => { delete store[k]; },
        clear: () => { Object.keys(store).forEach(k => delete store[k]); },
        get length() { return Object.keys(store).length; },
        key: (i: number) => Object.keys(store)[i] ?? null,
      },
      writable: true,
      configurable: true,
    });
  }
}
