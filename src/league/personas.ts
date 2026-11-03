/**
 * Names and traits for league strategies, so the leaderboard reads like a league of traders.
 * Deterministic: the same seed always gives the same person.
 */

/** One short, catchy word per strategy. Clones add a numeral: Blaze → Blaze II → Blaze III. */
export const NAMES = [
  "Ace", "Apex", "Atlas", "Axel", "Bandit", "Blaze", "Blitz", "Bolt", "Bones", "Boomer", "Bravo", "Bruno",
  "Buzz", "Cash", "Chase", "Chief", "Chip", "Clutch", "Cobra", "Comet", "Cosmo", "Crash", "Dash", "Diesel",
  "Dingo", "Domino", "Drift", "Duke", "Echo", "Edge", "Ember", "Fang", "Flash", "Flint", "Fox", "Frost",
  "Fury", "Gator", "Ghost", "Gizmo", "Glitch", "Goose", "Grit", "Gunner", "Hawk", "Havoc", "Hex", "Hondo",
  "Hustle", "Iggy", "Indy", "Iron", "Jazz", "Jet", "Jinx", "Jolt", "Juno", "Karma", "Kilo", "Kit",
  "Lucky", "Lynx", "Mako", "Mango", "Maverick", "Mojo", "Moose", "Nacho", "Neon", "Nitro", "Nova", "Onyx",
  "Ozzy", "Pepper", "Pike", "Pixel", "Quake", "Quill", "Radar", "Raven", "Razor", "Rebel", "Rex", "Riot",
  "Rocket", "Rogue", "Rook", "Rumble", "Rusty", "Saber", "Scout", "Shadow", "Shark", "Slick", "Spark", "Spike",
  "Storm", "Sully", "Tank", "Tango", "Titan", "Tiger", "Topaz", "Turbo", "Vandal", "Vega", "Viper", "Volt",
  "Wolf", "Wren", "Xeno", "Yeti", "Zap", "Zephyr", "Ziggy", "Zinc",
];

const ROMAN = ["", "", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII", "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX"];

/** "Blaze III" → "Blaze" (the family a clone belongs to). */
export function baseName(name: string): string {
  return name.replace(/ (?:[IVX]+|\d+)$/, "");
}

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

/** A rookie's name: an unused word from the list (a numbered one only if every word is taken). */
export function rookieName(r: () => number, taken: Set<string> = new Set()): string {
  const free = NAMES.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(r() * free.length) % free.length];
  return cloneName(pick(NAMES, r), taken);
}

/** A clone's name: its family name plus the next free numeral (Blaze → Blaze II, Blaze III…). */
export function cloneName(parentName: string, taken: Set<string> = new Set()): string {
  const base = baseName(parentName);
  for (let n = 2; ; n++) {
    const name = `${base} ${ROMAN[n] ?? String(n)}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Stable names for your own rules (sorted by id, so the same rules always get the same names),
 * drawn from the same list and never shared with each other.
 */
export function housePersonas(ruleIds: string[]): Map<string, { name: string; traits: Traits }> {
  const out = new Map<string, { name: string; traits: Traits }>();
  const used = new Set<string>();
  for (const id of [...new Set(ruleIds)].sort()) {
    const r = rng(hashSeed(id));
    let i = hashSeed(`name:${id}`) % NAMES.length;
    for (let k = 0; k < NAMES.length && used.has(NAMES[i]); k++) i = (i + 1) % NAMES.length;
    const name = used.has(NAMES[i]) ? cloneName(NAMES[i], used) : NAMES[i];
    used.add(name);
    out.set(id, { name, traits: randomTraits(r) });
  }
  return out;
}

// Before one-word names, your rules were shown as "First Last". Kept only so old league history can
// be renamed (see migrateNames); never used for new names.
const LEGACY_FIRST = [
  "Ava", "Milo", "Zara", "Theo", "Luna", "Felix", "Nora", "Otis", "Iris", "Jude", "Maya", "Rex",
  "Cleo", "Hugo", "Ruby", "Silas", "Nova", "Ezra", "Ivy", "Leo", "Wren", "Axel", "June", "Kai",
  "Esme", "Finn", "Lyra", "Omar", "Pia", "Quinn", "Rosa", "Seth", "Tess", "Uma", "Vince", "Willa",
  "Xena", "Yusuf", "Zoe", "Arlo", "Bea", "Cyrus", "Dahlia", "Emil", "Freya", "Gus", "Hazel", "Idris",
];
const LEGACY_LAST = [
  "Sterling", "Vance", "Okafor", "Lindqvist", "Moreau", "Tanaka", "Reyes", "Abara", "Kowalski", "Hart",
  "Castillo", "Nakamura", "Brandt", "Osei", "Valdez", "Petrov", "Achebe", "Lund", "Quill", "Ferro",
  "Ashby", "Marsh", "Iyer", "Duval", "Blackwood", "Santos", "Kaur", "Whitlock", "Rourke", "Mbeki",
];

/** The "First Last" name a rule of yours had before one-word names. */
export function legacyHouseName(ruleId: string): string {
  const r = rng(hashSeed(ruleId));
  return `${pick(LEGACY_FIRST, r)} ${pick(LEGACY_LAST, r)}`;
}
