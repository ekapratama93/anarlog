import type { MobileSyncSnapshot } from "./controller";

export type BackgroundSyncWork = {
  remaining: number;
  subtitle: string;
};

export function backgroundSyncWork(
  sync: Pick<
    MobileSyncSnapshot,
    | "phase"
    | "running"
    | "syncingNow"
    | "hasUnsentChanges"
    | "consecutiveFailures"
  >,
  pendingUploads: number,
): BackgroundSyncWork {
  if (sync.phase !== "ready" || !sync.running) {
    return { remaining: 0, subtitle: "Syncing notes" };
  }
  const syncPending =
    sync.syncingNow ||
    (sync.hasUnsentChanges === true && sync.consecutiveFailures === 0);
  const uploads = Math.max(0, pendingUploads);
  return {
    remaining: uploads + (syncPending ? 1 : 0),
    subtitle:
      uploads > 0
        ? `Uploading ${uploads} ${uploads === 1 ? "file" : "files"}`
        : "Syncing notes",
  };
}
