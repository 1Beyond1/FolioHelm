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

  return {
    route: routeValue,
    symbol: routeValue === "instrument" ? symbolValue : undefined,
  };
}

export function parseLocationHash(hash: string): AppLocation {
  const withoutPrefix = hash.replace(/^#\/?/, "");
  const [path, query = ""] = withoutPrefix.split("?");
  const [routeValue, symbolValue] = path.split("/");
  const route = isAppRoute(routeValue) ? routeValue : "home";
  const symbol = decodeSegment(symbolValue);

  if (route !== "trade") {
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
  const symbol = location.symbol ? `/${encodeURIComponent(location.symbol)}` : "";

  if (location.route !== "trade") {
    return `#/${location.route}${location.route === "instrument" ? symbol : ""}`;
  }

  const background = location.background ?? { route: "home" as const };
  const backgroundSymbol = background.symbol ? `/${encodeURIComponent(background.symbol)}` : "";
  const from = encodeURIComponent(`${background.route}${background.route === "instrument" ? backgroundSymbol : ""}`);
  return `#/trade${symbol}?from=${from}`;
}

export function sameLocation(left: AppLocation, right: AppLocation): boolean {
  return serializeLocation(left) === serializeLocation(right);
}

export function primaryRoute(route: AppRoute): Exclude<AppRoute, "instrument" | "settings"> | "markets" {
  return route === "instrument" ? "markets" : route === "settings" ? "home" : route;
}
