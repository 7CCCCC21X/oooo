export function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}
export function nowIso(): string {
  return new Date().toISOString();
}
