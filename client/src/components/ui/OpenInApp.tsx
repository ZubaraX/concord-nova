// For someone who opened an invite link in a browser: continue in the installed
// app, or get the app first. Renders nothing inside the apps themselves.
import type { ServerInfoDTO } from "@nova/shared";
import { inBrowser, openInviteInApp } from "../../lib/applink";
import { t } from "../../lib/i18n";
import { Button } from "./primitives";

export function OpenInApp({ code, downloads, className }: { code: string; downloads?: ServerInfoDTO["downloads"]; className?: string }) {
  if (!inBrowser()) return null;
  const android = /Android/i.test(navigator.userAgent);
  const download = android ? downloads?.android : downloads?.windows;
  return (
    <div className={className}>
      <Button block variant="secondary" onClick={() => openInviteInApp(code)}>
        {t("invite.openInApp")}
      </Button>
      {download && (
        <a href={download} target="_blank" rel="noreferrer noopener" className="mt-2 block text-center text-[13px] text-sky hover:underline">
          {t(android ? "invite.downloadAndroid" : "invite.downloadWindows")}
        </a>
      )}
    </div>
  );
}
