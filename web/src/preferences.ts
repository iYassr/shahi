/** Non-sensitive preferences are optional, including in storage-blocked browsers. */
export const preferences = {
  get(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } },
  set(key: string, value: string): void { try { localStorage.setItem(key, value); } catch { /* Session UI still works. */ } },
  remove(key: string): void { try { localStorage.removeItem(key); } catch { /* No durable preference available. */ } },
};
