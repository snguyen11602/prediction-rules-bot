/**
 * Names and traits for league strategies, so the leaderboard reads like a league of traders.
 * Deterministic: the same seed always gives the same person.
 */

const FIRST = [
  "Ava", "Milo", "Zara", "Theo", "Luna", "Felix", "Nora", "Otis", "Iris", "Jude", "Maya", "Rex",
  "Cleo", "Hugo", "Ruby", "Silas", "Nova", "Ezra", "Ivy", "Leo", "Wren", "Axel", "June", "Kai",
  "Esme", "Finn", "Lyra", "Omar", "Pia", "Quinn", "Rosa", "Seth", "Tess", "Uma", "Vince", "Willa",
  "Xena", "Yusuf", "Zoe", "Arlo", "Bea", "Cyrus", "Dahlia", "Emil", "Freya", "Gus", "Hazel", "Idris",
];
const LAST = [
  "Sterling", "Vance", "Okafor", "Lindqvist", "Moreau", "Tanaka", "Reyes", "Abara", "Kowalski", "Hart",
  "Castillo", "Nakamura", "Brandt", "Osei", "Valdez", "Petrov", "Achebe", "Lund", "Quill", "Ferro",
  "Ashby", "Marsh", "Iyer", "Duval", "Blackwood", "Santos", "Kaur", "Whitlock", "Rourke", "Mbeki",
];

/** Small seeded RNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const pick = <T>(xs: T[], r: () => number) => xs[Math.floor(r() * xs.length) % xs.length];

export interface Traits {
  /** Work ethic: how busy it is (more positions at once, shorter cool-downs). 0–1. */
  hustle: number;
  /** How different its clones are from it (mutation size). 0–1. */
  creativity: number;
  /** How many safety checks it uses before trading (stricter spreads, timing, exclusions). 0–1. */
  knowledge: number;
}

export function randomTraits(r: () => number): Traits {
  const t = () => Math.round((0.2 + r() * 0.6) * 100) / 100;
  return { hustle: t(), creativity: t(), knowledge: t() };
}

/** A clone inherits its parent's traits, nudged a little. */
export function inheritTraits(p: Traits, r: () => number): Traits {
  const nudge = (v: number) => Math.round(Math.min(0.95, Math.max(0.05, v + (r() - 0.5) * 0.2)) * 100) / 100;
  return { hustle: nudge(p.hustle), creativity: nudge(p.creativity), knowledge: nudge(p.knowledge) };
}

/** A new person; clones keep the family surname. */
export function personName(r: () => number, surname?: string, taken: Set<string> = new Set()): string {
  for (let i = 0; i < 50; i++) {
    const n = `${pick(FIRST, r)} ${surname ?? pick(LAST, r)}`;
    if (!taken.has(n)) return n;
  }
  return `${pick(FIRST, r)} ${surname ?? pick(LAST, r)} ${Math.floor(r() * 90 + 10)}`;
}

export const surnameOf = (name: string) => name.split(" ").slice(1).join(" ");

/** A stable persona for a rule you wrote yourself (house strategies). */
export function housePersona(ruleId: string): { name: string; traits: Traits } {
  const r = rng(hashSeed(ruleId));
  return { name: personName(r), traits: randomTraits(r) };
}
