import type { NormalizedMarket } from "../types.js";

/**
 * Find markets on Kalshi and Polymarket that ask the same question.
 *
 * Pure and deterministic. Deliberately strict, because a "match" that resolves
 * differently is not an arbitrage — it's two bets that can both lose:
 *  - every number must agree (25 bps ≠ 50 bps, $60k ≠ $65k; a year may be
 *    implied by the other market's close date),
 *  - every direction word must agree (cut vs hike, above vs below, win vs lose, not),
 *  - every name must appear on both sides (Pennsylvania ≠ Ohio, Trump ≠ Vance),
 *  - Polymarket outcomes must be plain Yes / No,
 *  - close times must be within `maxCloseGapHours`,
 *  - then rare shared words are scored (IDF-weighted Jaccard) and pairs are
 *    assigned one-to-one, best score first.
 * Anything it gets wrong can be fixed with the confirmed / blocked pairs file.
 */

export interface TitleFeatures {
  content: Set<string>;
  numbers: Set<string>;
  years: Set<string>;
  polarity: Set<string>;
  /** Capitalized words (people, places, teams, organizations), normalized like content. */
  names: Set<string>;
}

export interface MatchCandidate {
  kalshi: NormalizedMarket;
  polymarket: NormalizedMarket;
  score: number;
  /** IDF-weighted word overlap before bonuses. */
  overlap: number;
  shared: string[];
  ok: boolean;
  /** Why the pair can't be auto-matched (when ok is false). */
  reason?: string;
}

export interface MatchOptions {
  minScore: number;
  maxCloseGapHours: number;
  /** Also return rejected look-alikes (for review tools). */
  includeRejected?: boolean;
  /** Lowest score worth returning when includeRejected is set. */
  reviewFloor?: number;
}

const MONTHS: Record<string, string> = {
  jan: "january", feb: "february", mar: "march", apr: "april", jun: "june", jul: "july",
  aug: "august", sep: "september", sept: "september", oct: "october", nov: "november", dec: "december",
};

const PHRASES: Array<[RegExp, string]> = [
  [/\bfederal reserve\b/g, " fed "],
  [/\bfomc\b/g, " fed "],
  [/\bfed funds?\b/g, " fed "],
  [/\bunited states\b|\bu\.s\.(a\.)?/g, " us "],
  [/\bno change\b|\bunchanged\b|\bmaintains?\b|\bhold(s|ing)?\b|\bpause[sd]?\b/g, " hold "],
  [/\bbasis points?\b|\bbps?\b/g, " bps "],
  [/\bper ?cent\b|%/g, " pct "],
  [/\binterest rates?\b|\brates?\b/g, " rate "],
  [/\bhigher than\b|\bgreater than\b|\bmore than\b|\bat least\b|\bor (more|higher|above)\b/g, " gt "],
  [/\blower than\b|\bless than\b|\bfewer than\b|\bat most\b|\bor (less|lower|below)\b/g, " lt "],
];

const POLARITY: Record<string, string> = {
  cut: "down", cuts: "down", lower: "down", lowers: "down", lowered: "down", decrease: "down",
  decreases: "down", decreased: "down", reduce: "down", reduces: "down", reduced: "down",
  drop: "down", drops: "down", fall: "down", falls: "down", decline: "down", declines: "down",
  hike: "up", hikes: "up", raise: "up", raises: "up", raised: "up", increase: "up", increases: "up",
  increased: "up", rise: "up", rises: "up", higher: "up",
  above: "gt", over: "gt", exceed: "gt", exceeds: "gt", gt: "gt",
  below: "lt", under: "lt", lt: "lt",
  hold: "hold",
  not: "not", no: "not", never: "not", without: "not", wont: "not", fail: "not", fails: "not",
  win: "win", wins: "win", won: "win", winner: "win", winning: "win",
  lose: "lose", loses: "lose", lost: "lose", loser: "lose",
};

const STOPWORDS = new Set(
  ("will the a an of in on at by be to for is are was were and or with as it its this that from " +
    "than any after before until during between into what which who how when does do did has have " +
    "had there their his her next end yes question market markets occur happen")
    .split(" "),
);

const WEEKDAYS = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
/** Capitalized but not distinctive enough to require on both sides. */
const GENERIC_NAMES = new Set(["us", "usa", "america", "american", "national", "state", "states", "united"]);
const NAME_PHRASES: Array<[RegExp, string]> = [
  [/\bFederal Reserve\b/g, "Fed"],
  [/\bFOMC\b/g, "Fed"],
  [/\bU\.S\.(A\.)?/g, "US"],
];

function normalizeWord(w: string): string {
  let t = w.toLowerCase().replace(/[’']s$/, "").replace(/[’'.]/g, "");
  t = MONTHS[t] ?? t;
  if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  return t;
}

/** Capitalized words that aren't just the first word of a sentence / segment. */
function extractNames(title: string): Set<string> {
  let s = title;
  for (const [re, rep] of NAME_PHRASES) s = s.replace(re, rep);
  const names = new Set<string>();
  for (const segment of s.split(/[—–?:;!|]+|\s-\s/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    words.forEach((w, i) => {
      const clean = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.’']+$/g, "");
      if (i === 0 || !/^[A-Z]/.test(clean)) return;
      const t = normalizeWord(clean);
      if (t.length < 2 || STOPWORDS.has(t) || POLARITY[t] || GENERIC_NAMES.has(t) || WEEKDAYS.has(t)) return;
      if (Object.values(MONTHS).includes(t) || t === "may") return;
      names.add(t);
    });
  }
  return names;
}

const MULTIPLIERS: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12,
};

function canonicalNumber(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

export function titleFeatures(title: string): TitleFeatures {
  let s = ` ${title.toLowerCase().replace(/[’']/g, "")} `;
  for (const [re, rep] of PHRASES) s = s.replace(re, rep);
  s = s
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/([a-z])(\d)/g, "$1 $2");
  const raw = s
    .split(/[^a-z0-9.]+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .map((t) => (/^\d/.test(t) ? t : t.replace(/\./g, "")))
    .filter(Boolean);

  const content = new Set<string>();
  const numbers = new Set<string>();
  const years = new Set<string>();
  const polarity = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    let t = raw[i];
    if (/^\d+(\.\d+)?$/.test(t)) {
      let n = Number(t);
      const mult = MULTIPLIERS[raw[i + 1] ?? ""];
      if (mult) {
        n *= mult;
        i += 1;
      }
      if (Number.isInteger(n) && n >= 2000 && n <= 2100 && !mult) years.add(String(n));
      else numbers.add(canonicalNumber(n));
      continue;
    }
    t = MONTHS[t] ?? t;
    const pol = POLARITY[t];
    if (pol) {
      polarity.add(pol);
      continue;
    }
    if (STOPWORDS.has(t) || t.length < 2) continue;
    if (t.length > 4 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    content.add(t);
  }
  const names = new Set([...extractNames(title)].filter((n) => content.has(n)));
  return { content, numbers, years, polarity, names };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function closeYear(m: NormalizedMarket): string | undefined {
  if (!m.closesAt) return undefined;
  const d = new Date(m.closesAt);
  return Number.isFinite(d.getTime()) ? String(d.getUTCFullYear()) : undefined;
}

/** Years must agree; a year on only one side is fine if the other market closes that year. */
function yearsCompatible(a: TitleFeatures, b: TitleFeatures, ma: NormalizedMarket, mb: NormalizedMarket): boolean {
  if (a.years.size && b.years.size) return sameSet(a.years, b.years);
  const only = a.years.size ? a.years : b.years;
  if (!only.size) return true;
  const other = a.years.size ? mb : ma;
  const y = closeYear(other);
  return only.size === 1 && y != null && only.has(y);
}

function plainYesNo(m: NormalizedMarket): boolean {
  if (!m.outcomes) return true;
  return m.outcomes.length === 2 && m.outcomes[0].toLowerCase() === "yes" && m.outcomes[1].toLowerCase() === "no";
}

function openForMatching(m: NormalizedMarket): boolean {
  return (m.status ?? "open") === "open";
}

/** Score one pair. `idf` weights rare words above common ones. */
export function scorePair(
  kalshi: NormalizedMarket,
  polymarket: NormalizedMarket,
  fk: TitleFeatures,
  fp: TitleFeatures,
  idf: (t: string) => number,
  opts: Pick<MatchOptions, "maxCloseGapHours">,
): Omit<MatchCandidate, "kalshi" | "polymarket"> {
  const shared = [...fk.content].filter((t) => fp.content.has(t));
  const union = new Set([...fk.content, ...fp.content]);
  let inter = 0;
  let all = 0;
  for (const t of union) {
    const w = idf(t);
    all += w;
    if (fk.content.has(t) && fp.content.has(t)) inter += w;
  }
  const overlap = all > 0 ? inter / all : 0;
  // Agreeing numbers / direction are strong evidence, but only on top of real word overlap.
  let score = overlap;
  if (overlap >= 0.35) {
    if (fk.numbers.size && sameSet(fk.numbers, fp.numbers)) score += 0.15;
    if (fk.years.size && fp.years.size && sameSet(fk.years, fp.years)) score += 0.05;
    if (fk.polarity.size && sameSet(fk.polarity, fp.polarity)) score += 0.1;
  }
  score = Math.min(1, Math.round(score * 1000) / 1000);

  const reject = (reason: string) => ({ score, overlap, shared, ok: false, reason });
  if (!sameSet(fk.numbers, fp.numbers)) return reject("numbers differ");
  if (!yearsCompatible(fk, fp, kalshi, polymarket)) return reject("years differ");
  if (!sameSet(fk.polarity, fp.polarity)) return reject("direction words differ");
  const missing = [...[...fk.names].filter((n) => !fp.content.has(n)), ...[...fp.names].filter((n) => !fk.content.has(n))];
  if (missing.length) return reject(`names differ (${missing.slice(0, 3).join(", ")})`);
  if (!plainYesNo(polymarket)) return reject("Polymarket outcomes are not Yes/No");
  if (shared.length < 2) return reject("too few shared words");
  if (kalshi.closesAt && polymarket.closesAt) {
    const gap = Math.abs(new Date(kalshi.closesAt).getTime() - new Date(polymarket.closesAt).getTime()) / 3600_000;
    if (!(gap <= opts.maxCloseGapHours)) return reject(`close times ${Math.round(gap)}h apart`);
  }
  return { score, overlap, shared, ok: true };
}

/**
 * Best one-to-one matches between Kalshi and Polymarket markets.
 * Returns accepted pairs (score ≥ minScore) and, with includeRejected, near misses.
 */
export function findMatches(
  kalshiMarkets: NormalizedMarket[],
  polyMarkets: NormalizedMarket[],
  opts: MatchOptions,
): MatchCandidate[] {
  const ks = kalshiMarkets.filter((m) => m.platform === "kalshi" && openForMatching(m));
  const ps = polyMarkets.filter((m) => m.platform === "polymarket" && openForMatching(m));
  const fK = ks.map((m) => titleFeatures(m.title));
  const fP = ps.map((m) => titleFeatures(m.title));

  const df = new Map<string, number>();
  for (const f of [...fK, ...fP]) for (const t of f.content) df.set(t, (df.get(t) ?? 0) + 1);
  const n = fK.length + fP.length;
  const idf = (t: string) => Math.log(1 + n / (1 + (df.get(t) ?? 0)));

  // Only compare markets that share at least one word.
  const index = new Map<string, number[]>();
  fP.forEach((f, j) => {
    for (const t of f.content) {
      const list = index.get(t) ?? [];
      list.push(j);
      index.set(t, list);
    }
  });

  const scored: MatchCandidate[] = [];
  fK.forEach((fk, i) => {
    const seen = new Set<number>();
    for (const t of fk.content) for (const j of index.get(t) ?? []) seen.add(j);
    for (const j of seen) {
      const r = scorePair(ks[i], ps[j], fk, fP[j], idf, opts);
      const passes = r.ok && r.score >= opts.minScore;
      const candidate: MatchCandidate = passes
        ? { kalshi: ks[i], polymarket: ps[j], ...r }
        : { kalshi: ks[i], polymarket: ps[j], ...r, ok: false, reason: r.reason ?? `score ${r.score} < ${opts.minScore}` };
      if (passes || (opts.includeRejected && r.score >= (opts.reviewFloor ?? 0.3))) scored.push(candidate);
    }
  });

  scored.sort((a, b) => Number(b.ok) - Number(a.ok) || b.score - a.score);
  const usedK = new Set<string>();
  const usedP = new Set<string>();
  const out: MatchCandidate[] = [];
  for (const c of scored) {
    if (c.ok) {
      if (usedK.has(c.kalshi.id) || usedP.has(c.polymarket.id)) continue;
      usedK.add(c.kalshi.id);
      usedP.add(c.polymarket.id);
      out.push(c);
    } else if (opts.includeRejected && !usedK.has(c.kalshi.id) && !usedP.has(c.polymarket.id)) {
      out.push(c);
    }
  }
  return out;
}
