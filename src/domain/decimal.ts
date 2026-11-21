/**
 * Exact decimal primitives for financial domain values.
 *
 * The UI may convert a value to a number at the SVG/layout boundary, but
 * account, order, price and quantity state must stay in this representation.
 * No floating-point arithmetic is used here.
 */
export type DecimalString = string & { readonly __foliohelmDecimal: unique symbol };
export type Money = DecimalString & { readonly __foliohelmMoney: unique symbol };
export type Price = DecimalString & { readonly __foliohelmPrice: unique symbol };
export type Quantity = DecimalString & { readonly __foliohelmQuantity: unique symbol };
export type Percent = DecimalString & { readonly __foliohelmPercent: unique symbol };
export type DecimalRoundingMode = "half-even" | "half-up" | "truncate";

interface ParsedDecimal {
  coefficient: bigint;
  scale: number;
}

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function parseDecimal(value: string): ParsedDecimal {
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) throw new Error(`Invalid decimal: ${value}`);

  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/, "");
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const digits = `${wholePart || "0"}${fractionPart}`.replace(/^0+(?=\d)/, "") || "0";

  return {
    coefficient: BigInt(`${negative ? "-" : ""}${digits}`),
    scale: fractionPart.length,
  };
}

function powerOfTen(scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`Invalid decimal scale: ${scale}`);
  return 10n ** BigInt(scale);
}

function normalizeParsed(parsed: ParsedDecimal): ParsedDecimal {
  let coefficient = parsed.coefficient;
  let scale = parsed.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}

function stringifyDecimal(parsed: ParsedDecimal): DecimalString {
  const normalized = normalizeParsed(parsed);
  if (normalized.coefficient === 0n) return "0" as DecimalString;

  const negative = normalized.coefficient < 0n;
  const digits = (negative ? -normalized.coefficient : normalized.coefficient).toString();
  if (normalized.scale === 0) return `${negative ? "-" : ""}${digits}` as DecimalString;

  const padded = digits.padStart(normalized.scale + 1, "0");
  const split = padded.length - normalized.scale;
  return `${negative ? "-" : ""}${padded.slice(0, split)}.${padded.slice(split)}` as DecimalString;
}

export function decimal(value: string): DecimalString {
  return stringifyDecimal(parseDecimal(value));
}

export function money(value: string): Money {
  return decimal(value) as Money;
}

export function price(value: string): Price {
  return decimal(value) as Price;
}

export function quantity(value: string): Quantity {
  return decimal(value) as Quantity;
}

export function percent(value: string): Percent {
  return decimal(value) as Percent;
}

export function decimalCompare(left: DecimalString, right: DecimalString): -1 | 0 | 1 {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const aCoefficient = a.coefficient * powerOfTen(scale - a.scale);
  const bCoefficient = b.coefficient * powerOfTen(scale - b.scale);
  return aCoefficient < bCoefficient ? -1 : aCoefficient > bCoefficient ? 1 : 0;
}

export function decimalAdd(left: DecimalString, right: DecimalString): DecimalString {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  return stringifyDecimal({
    coefficient: a.coefficient * powerOfTen(scale - a.scale) + b.coefficient * powerOfTen(scale - b.scale),
    scale,
  });
}

export function decimalSubtract(left: DecimalString, right: DecimalString): DecimalString {
  return decimalAdd(left, stringifyDecimal({ coefficient: -parseDecimal(right).coefficient, scale: parseDecimal(right).scale }));
}

function divideAndRoundMagnitude(
  numerator: bigint,
  denominator: bigint,
  mode: DecimalRoundingMode,
): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n || mode === "truncate") return quotient;

  const twiceRemainder = remainder * 2n;
  if (mode === "half-up") {
    return twiceRemainder >= denominator ? quotient + 1n : quotient;
  }

  // half-even (banker's rounding)
  if (twiceRemainder > denominator) return quotient + 1n;
  if (twiceRemainder < denominator) return quotient;
  return quotient % 2n === 1n ? quotient + 1n : quotient;
}

export function decimalMultiply(left: DecimalString, right: DecimalString): DecimalString {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  return stringifyDecimal({ coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale });
}

export function decimalRound(
  value: DecimalString,
  scale: number,
  mode: DecimalRoundingMode = "half-even",
): DecimalString {
  const parsed = parseDecimal(value);
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`Invalid target scale: ${scale}`);
  if (parsed.scale <= scale) return stringifyDecimal(parsed);

  const negative = parsed.coefficient < 0n;
  const absCoefficient = negative ? -parsed.coefficient : parsed.coefficient;
  const divisor = powerOfTen(parsed.scale - scale);
  const roundedAbs = divideAndRoundMagnitude(absCoefficient, divisor, mode);
  const coefficient = negative && roundedAbs !== 0n ? -roundedAbs : roundedAbs;
  return stringifyDecimal({ coefficient, scale });
}

export function decimalDivide(
  dividend: DecimalString,
  divisor: DecimalString,
  scale = 8,
  mode: DecimalRoundingMode = "half-even",
): DecimalString {
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`Invalid target scale: ${scale}`);
  const a = parseDecimal(dividend);
  const b = parseDecimal(divisor);
  if (b.coefficient === 0n) throw new Error("Cannot divide decimal by zero");

  const negative = (a.coefficient < 0n) !== (b.coefficient < 0n);
  const absDividend = a.coefficient < 0n ? -a.coefficient : a.coefficient;
  const absDivisor = b.coefficient < 0n ? -b.coefficient : b.coefficient;

  const netScaleShift = scale + b.scale - a.scale;
  const numerator = netScaleShift >= 0 ? absDividend * powerOfTen(netScaleShift) : absDividend;
  const denominator = netScaleShift >= 0 ? absDivisor : absDivisor * powerOfTen(-netScaleShift);

  const roundedAbs = divideAndRoundMagnitude(numerator, denominator, mode);
  const coefficient = negative && roundedAbs !== 0n ? -roundedAbs : roundedAbs;
  return stringifyDecimal({ coefficient, scale });
}

export function decimalAbs(value: DecimalString): DecimalString {
  const parsed = parseDecimal(value);
  return stringifyDecimal({ coefficient: parsed.coefficient < 0n ? -parsed.coefficient : parsed.coefficient, scale: parsed.scale });
}

export function decimalIsPositive(value: DecimalString): boolean {
  return parseDecimal(value).coefficient > 0n;
}

export function decimalIsNegative(value: DecimalString): boolean {
  return parseDecimal(value).coefficient < 0n;
}

export function decimalIsZero(value: DecimalString): boolean {
  return parseDecimal(value).coefficient === 0n;
}

export function decimalToNumber(value: DecimalString): number {
  return Number(value);
}

export function decimalToFixed(
  value: DecimalString,
  scale: number,
  roundingMode?: DecimalRoundingMode,
): string {
  if (!Number.isInteger(scale) || scale < 0) throw new Error(`Invalid target scale: ${scale}`);
  const source = roundingMode === undefined ? value : decimalRound(value, scale, roundingMode);
  const parsed = parseDecimal(source);

  let coefficient: bigint;
  if (scale < parsed.scale) {
    const divisor = powerOfTen(parsed.scale - scale);
    const remainder = parsed.coefficient % divisor;
    if (remainder !== 0n) throw new Error(`Cannot represent ${value} at scale ${scale}`);
    coefficient = parsed.coefficient / divisor;
  } else {
    coefficient = parsed.coefficient * powerOfTen(scale - parsed.scale);
  }
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
  if (scale === 0) return `${negative ? "-" : ""}${digits}`;
  return `${negative ? "-" : ""}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export function decimalCanonicalJson(value: DecimalString): string {
  return decimal(value);
}
