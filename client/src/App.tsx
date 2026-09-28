import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useSession } from "./store/session";
import { useData } from "./store/data";
import { connectGateway, useConnection } from "./lib/gateway";
import { t, useLocale } from "./lib/i18n";
import { Ignition } from "./components/Logo";
import { Toasts } from "./components/ui/toasts";
import { ContextMenuProvider } from "./components/ui/overlay";
import { AuthScreen } from "./features/auth/AuthScreen";
import { AppShell } from "./features/shell/AppShell";
import { TitleBar } from "./features/shell/TitleBar";
import { ErrorBoundary } from "./features/shell/ErrorBoundary";
import { isDesktop } from "./lib/platform";

export function App() {
  useLocale();
  const status = useSession((s) => s.status);
  const ready = useData((s) => s.ready);
  const conn = useConnection((s) => s.state);

  useEffect(() => {
    if (status === "authed") connectGateway();
  }, [status]);

  return (
    <ErrorBoundary>
      <ContextMenuProvider>
        <div className="nova-sky" />
        <div className="relative z-10 flex h-full flex-col">
          {isDesktop && <TitleBar />}
          <div className="relative min-h-0 flex-1">
            <AnimatePresence mode="wait">
              {status === "anon" ? (
                <motion.div key="auth" className="absolute inset-0" exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                  <AuthScreen />
                </motion.div>
              ) : !ready ? (
                <motion.div key="boot" className="absolute inset-0" exit={{ opacity: 0, scale: 1.04 }} transition={{ duration: 0.35 }}>
                  <Ignition status={conn === "offline" ? t("app.offline") : conn === "reconnecting" ? t("app.reconnecting") : t("app.connecting")} />
                </motion.div>
              ) : (
                <motion.div key="app" className="absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
                  <AppShell />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
        <Toasts />
      </ContextMenuProvider>
    </ErrorBoundary>
  );
}
