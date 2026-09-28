import type { PresenceDTO } from "@nova/shared";
import { t } from "../../lib/i18n";

/** Short line under a name: custom status first, then what they're doing. */
export function activityText(p: PresenceDTO | undefined): string | null {
  if (!p) return null;
  if (p.customStatus && (p.customStatus.text || p.customStatus.emoji)) return [p.customStatus.emoji, p.customStatus.text].filter(Boolean).join(" ");
  const a = p.activities[0];
  if (a) return t(`status.${a.type}`, { name: a.name });
  return null;
}
