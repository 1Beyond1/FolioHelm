import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

function isChinese(): boolean {
  return typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Keep diagnostics in the local developer console only. Do not persist
    // component stacks or user data in the app's evidence journal.
    console.error("FolioHelm rendered an unrecoverable UI error", error, errorInfo);
  }

  handleReload = (): void => {
    if (typeof window !== "undefined") window.location.reload();
  };

  render() {
    if (!this.state.error) return this.props.children;

    const chinese = isChinese();
    return (
      <main className="app-error-boundary" data-testid="app-error-boundary">
        <div className="app-error-boundary__card" role="alert">
          <span className="app-error-boundary__eyebrow">FolioHelm</span>
          <h1>{chinese ? "页面暂时出了问题" : "The page hit an error"}</h1>
          <p>
            {chinese
              ? "本地偏好和演示数据不会因为这次渲染错误而被清除。你可以重新加载应用继续。"
              : "Your local preferences and demo data were not cleared. Reload the app to continue."}
          </p>
          <button type="button" onClick={this.handleReload}>
            {chinese ? "重新加载应用" : "Reload app"}
          </button>
        </div>
      </main>
    );
  }
}

