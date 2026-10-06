/**
 * MACs are the registry's key and the lease file's name: uppercase hex pairs
 * joined by colons. Accepts `a0f2…`, `A0-F2-…` and `a0:f2:…`.
 */
export function normalizeMac(text: string): string | undefined {
  const hex = text.trim().replace(/[:\-.]/g, "").toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(hex)) return undefined;
  return hex.match(/../g)!.join(":");
}

export function isMac(text: string): boolean {
  return normalizeMac(text) !== undefined;
}
