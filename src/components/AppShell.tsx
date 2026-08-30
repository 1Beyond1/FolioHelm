import type { ReactNode } from "react";
import type { Copy } from "../i18n";
import type { Language } from "../types";
import type { AppRoute } from "../navigation";
import type { DisplayDataStatus } from "./DataStateNotice";
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
  dataStatus?: DisplayDataStatus | null;
  persistenceWarning?: string;
  onDismissPersistenceWarning?: () => void;
  children: ReactNode;
}

export function AppShell({
  copy,
  language,
  activeRoute,
  onLanguageChange,
  onNavigate,
  onSearch,
  dataStatus = null,
  persistenceWarning,
  onDismissPersistenceWarning,
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
        dataStatus={dataStatus}
      />
      <SystemStatusBar copy={copy} dataStatus={dataStatus} />
      {persistenceWarning && (
        <section className="persistence-warning" role="alert">
          <span>{persistenceWarning}</span>
          <button type="button" onClick={onDismissPersistenceWarning}>{copy.dismiss}</button>
        </section>
      )}
      <div className="app-content">{children}</div>
      <Footer copy={copy} />
    </div>
  );
}
