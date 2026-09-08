import { browserConnection, hosted } from "./connection";
const scoped = (key: string) => hosted && browserConnection().identity && ["shahi.pins", "shahi.push.dismissed"].includes(key)
  ? `${key}.${browserConnection().identity!.serverId}` : key;
/** Non-sensitive preferences are optional, including in storage-blocked browsers. */
export const preferences = {
  get(key: string): string | null { try { return localStorage.getItem(scoped(key)); } catch { return null; } },
  set(key: string, value: string): void { try { localStorage.setItem(scoped(key), value); } catch { /* Session UI still works. */ } },
  remove(key: string): void { try { localStorage.removeItem(scoped(key)); } catch { /* No durable preference available. */ } },
};
