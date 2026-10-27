/** Risk "day" boundary used for daily loss caps (YYYY-MM-DD, America/Los_Angeles). */
export function dayKeyLA(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}
