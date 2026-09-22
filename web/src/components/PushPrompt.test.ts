import { afterEach, beforeEach, expect, test } from "bun:test";
import { api } from "../api";
import { ONE_COMPUTER, registerPush, subscribedWith, unregisterPush } from "./PushPrompt";

/**
 * One browser, several computers, one push subscription.
 *
 * Every computer signs its pushes with its own VAPID key, and a subscription
 * accepts only the key it was made with — so the hosted app, where computers
 * share a service worker, can deliver notifications for one computer at a time.
 */
const KEY_A = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const KEY_B = "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI";
const bytes = (key: string) => Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=")), (c) => c.charCodeAt(0)).buffer;

interface FakeSubscription { endpoint: string; options: { applicationServerKey: ArrayBuffer }; unsubscribed: boolean; unsubscribe(): Promise<boolean>; toJSON(): object }
function subscription(endpoint: string, key: string): FakeSubscription {
  return {
    endpoint, options: { applicationServerKey: bytes(key) }, unsubscribed: false,
    async unsubscribe() { this.unsubscribed = true; current = null; return true; },
    toJSON() { return { endpoint }; },
  };
}

let current: FakeSubscription | null;
let serverKey: string;
let registered: string[];
let unregistered: string[];
let created: string[];
const restore: Array<() => void> = [];
function replace<T extends object, K extends keyof T>(target: T, key: K, value: T[K]) {
  const had = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  restore.push(() => { if (had) Object.defineProperty(target, key, had); else delete (target as Record<PropertyKey, unknown>)[key as PropertyKey]; });
}

beforeEach(() => {
  current = null; serverKey = KEY_B; registered = []; unregistered = []; created = [];
  const pushManager = {
    getSubscription: async () => current,
    subscribe: async ({ applicationServerKey }: { applicationServerKey: ArrayBuffer }) => {
      const key = [KEY_A, KEY_B].find((candidate) => new Uint8Array(bytes(candidate)).join() === new Uint8Array(applicationServerKey).join())!;
      created.push(key);
      return (current = subscription(`https://push.example/${created.length}`, key));
    },
  };
  const registration = { pushManager };
  replace(globalThis, "navigator", { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration), getRegistration: async () => registration } } as never);
  replace(api, "pushKey", async () => ({ publicKey: serverKey }));
  replace(api, "pushSubscribe", async (value: { endpoint?: string }) => { registered.push(value.endpoint ?? ""); return {} as never; });
  replace(api, "pushUnsubscribe", async (endpoint: string) => { unregistered.push(endpoint); return {} as never; });
});
afterEach(() => { while (restore.length) restore.pop()!(); });

test("a subscription is recognised by the key it was made with", () => {
  expect(subscribedWith(subscription("https://push.example/a", KEY_A) as never, KEY_A)).toBe(true);
  expect(subscribedWith(subscription("https://push.example/a", KEY_A) as never, KEY_B)).toBe(false);
});

test("a second computer does not adopt the first computer's notifications and report them on", async () => {
  const first = (current = subscription("https://push.example/computer-a", KEY_A));
  await expect(registerPush(0)).rejects.toThrow(ONE_COMPUTER);
  // Handing computer B a subscription signed for computer A was the bug: B
  // said "Notifications on", and every push it sent was rejected.
  expect(registered).toEqual([]);
  expect(first.unsubscribed).toBe(false);
});

test("moving notifications to this computer is a choice, and makes a subscription for its key", async () => {
  const first = (current = subscription("https://push.example/computer-a", KEY_A));
  await expect(registerPush(0, () => false)).rejects.toThrow(ONE_COMPUTER);
  expect(first.unsubscribed).toBe(false);
  await registerPush(0, () => true);
  expect(first.unsubscribed).toBe(true);
  expect(created).toEqual([KEY_B]);
  expect(registered).toEqual(["https://push.example/1"]);
});

test("the computer that owns the subscription registers it again without asking", async () => {
  current = subscription("https://push.example/computer-b", KEY_B);
  await registerPush(0, () => { throw new Error("must not ask"); });
  expect(registered).toEqual(["https://push.example/computer-b"]);
  expect(created).toEqual([]);
});

test("disabling notifications on one computer leaves another computer's notifications on", async () => {
  const other = (current = subscription("https://push.example/computer-a", KEY_A));
  await unregisterPush(0);
  expect(other.unsubscribed).toBe(false);
  // This computer still forgets the endpoint: a registration it held for the
  // other computer's subscription could only fail on every send.
  expect(unregistered).toEqual(["https://push.example/computer-a"]);
  unregistered = [];

  const own = (current = subscription("https://push.example/computer-b", KEY_B));
  await unregisterPush(0);
  expect(own.unsubscribed).toBe(true);
  expect(unregistered).toEqual(["https://push.example/computer-b"]);
});
