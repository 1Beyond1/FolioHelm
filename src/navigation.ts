export type AppRoute =
  | "home"
  | "markets"
  | "instrument"
  | "portfolio"
  | "orders"
  | "automation"
  | "trade"
  | "settings";

export interface NavigationState {
  route: AppRoute;
  symbol?: string;
}

export interface AppLocation extends NavigationState {
  /**
   * The page underneath a trade dialog. Keeping it in the URL means a
   * refresh, back, or forward action can restore the same context.
   */
  background?: NavigationState;
}

const ROUTES: readonly AppRoute[] = [
  "home",
  "markets",
  "instrument",
  "portfolio",
  "orders",
  "automation",
  "trade",
  "settings",
];

function isAppRoute(value: string | undefined): value is AppRoute {
  return value !== undefined && ROUTES.includes(value as AppRoute);
}

function decodeSegment(value: string | undefined): string | undefined {
  if (!value) return undefined;

  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function parsePath(value: string | undefined): NavigationState | undefined {
  const decoded = decodeSegment(value);
  if (!decoded) return undefined;

  const [routeValue, symbolValue] = decoded.split("/");
  if (!isAppRoute(routeValue) || routeValue === "trade") return undefined;

  const normalizedSymbol = symbolValue?.trim();
  if (routeValue === "instrument" && !normalizedSymbol) return { route: "markets" };

  return {
    route: routeValue,
    symbol: routeValue === "instrument" ? normalizedSymbol : undefined,
  };
}

export function parseLocationHash(hash: string): AppLocation {
  const withoutPrefix = hash.replace(/^#\/?/, "");
  const [path, query = ""] = withoutPrefix.split("?");
  const [routeValue, symbolValue] = path.split("/");
  const route = isAppRoute(routeValue) ? routeValue : "home";
  const symbol = decodeSegment(symbolValue)?.trim() || undefined;

  if (route !== "trade") {
    // An instrument route without a decodable symbol must not silently fall
    // back to AAPL in the view layer. Return to the symbol picker instead.
    if (route === "instrument" && !symbol) return { route: "markets" };
    return {
      route,
      symbol: route === "instrument" ? symbol : undefined,
    };
  }

  const params = new URLSearchParams(query);
  const background = parsePath(params.get("from") ?? undefined) ?? { route: "home" as const };

  return { route, symbol, background };
}

export function serializeLocation(location: AppLocation): string {
  const trimmedSymbol = location.symbol?.trim();
  const symbol = trimmedSymbol ? `/${encodeURIComponent(trimmedSymbol)}` : "";

  if (location.route !== "trade") {
    if (location.route === "instrument" && !trimmedSymbol) return "#/markets";
    return `#/${location.route}${location.route === "instrument" ? symbol : ""}`;
  }

  const rawBackground = location.background ?? { route: "home" as const };
  const background = rawBackground.route === "instrument" && !rawBackground.symbol?.trim()
    ? { route: "markets" as const }
    : rawBackground;
  const backgroundSymbol = background.symbol?.trim() ? `/${encodeURIComponent(background.symbol.trim())}` : "";
  const from = encodeURIComponent(`${background.route}${background.route === "instrument" ? backgroundSymbol : ""}`);
  return `#/trade${symbol}?from=${from}`;
}

export function sameLocation(left: AppLocation, right: AppLocation): boolean {
  return serializeLocation(left) === serializeLocation(right);
}

export function primaryRoute(route: AppRoute): Exclude<AppRoute, "instrument" | "settings"> | "markets" | null {
  return route === "instrument" ? "markets" : route === "settings" ? null : route;
}
