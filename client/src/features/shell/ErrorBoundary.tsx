import { Component, type ReactNode } from "react";
import { t } from "../../lib/i18n";

interface State {
  error: Error | null;
}

/** Last line of defense: a render crash shows a recoverable screen, not a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error("[ui crash]", error);
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="font-display text-2xl font-semibold">{t("app.crashTitle")}</div>
        <p className="max-w-md text-fg-2">{t("app.crashText")}</p>
        <pre className="max-w-xl overflow-auto rounded-xl bg-canvas p-3 text-left text-[12px] text-fg-3">{String(this.state.error?.message ?? this.state.error)}</pre>
        <button onClick={() => location.reload()} className="star-fill rounded-xl px-5 py-2.5 font-semibold">
          {t("app.reload")}
        </button>
      </div>
    );
  }
}
