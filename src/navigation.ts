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

export function primaryRoute(route: AppRoute): Exclude<AppRoute, "instrument" | "settings"> | "markets" {
  return route === "instrument" ? "markets" : route === "settings" ? "home" : route;
}
