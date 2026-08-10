import type { ReactNode } from "react";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import type { AppRoute } from "../navigation";
import { Footer } from "./Footer";
import { SystemStatusBar } from "./SystemStatusBar";
import { TopBar } from "./TopBar";

interface AppShellProps {
  copy: Copy;
  language: Language;
  activeRoute: AppRoute;
  onLanguageChange: (language: Language) => void;
  onNavigate: (route: AppRoute) => void;
  onSearch: () => void;
  children: ReactNode;
}

export function AppShell({
  copy,
  language,
  activeRoute,
  onLanguageChange,
  onNavigate,
  onSearch,
  children,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <TopBar
        copy={copy}
        language={language}
        activeRoute={activeRoute}
        onLanguageChange={onLanguageChange}
        onNavigate={onNavigate}
        onSearch={onSearch}
      />
      <SystemStatusBar copy={copy} />
      <main>{children}</main>
      <Footer copy={copy} />
    </div>
  );
}
