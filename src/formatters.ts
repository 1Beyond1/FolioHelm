import type { Language } from "./types";

function localeFor(language: Language): string {
  return language === "zh" ? "zh-CN" : "en-US";
}

export function formatCurrency(value: number, language: Language, currency = "USD"): string {
  if (!Number.isFinite(value)) return "—";
  const safeCurrency = /^[A-Z]{3}$/.test(currency) && currency !== "MULTI" ? currency : "USD";
  try {
    return new Intl.NumberFormat(localeFor(language), {
      style: "currency",
      currency: safeCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${safeCurrency} ${value.toFixed(2)}`;
  }
}

export function formatSignedCurrency(value: number, language: Language, currency = "USD"): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return formatCurrency(0, language, currency);
  return value > 0
    ? `+${formatCurrency(value, language, currency)}`
    : `-${formatCurrency(Math.abs(value), language, currency)}`;
}

export function formatSignedPercent(value: number, language: Language): string {
  if (!Number.isFinite(value)) return "—";
  const formatted = new Intl.NumberFormat(localeFor(language), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(value));

  if (value === 0) return `±${formatted}%`;
  return `${value > 0 ? "+" : "-"}${formatted}%`;
}

export function formatHeatmapDate(isoDate: string, language: Language): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(localeFor(language), {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
