/**
 * Release and bun version order. Its own module, with no imports, because the
 * first build step of `herdr plugin install` (requirements.ts) runs it before
 * any dependency is installed.
 */
export function compareVersion(a: string, b: string): number {
  const [aa, ab] = a.split("-beta."); const [ba, bb] = b.split("-beta.");
  const av = aa!.split(".").map(Number), bv = ba!.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i]! - bv[i]!;
  return ab === bb ? 0 : ab === undefined ? 1 : bb === undefined ? -1 : Number(ab) - Number(bb);
}
