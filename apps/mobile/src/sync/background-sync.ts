import { AppState } from "react-native";

import { requestMobileAttachmentUploads } from "@/attachment-sync/upload-runner";
import { countDueMobileAttachmentUploads } from "@/attachment-sync/upload-store";
import { captureOperationalError } from "@/lib/error-reporting";

import BackgroundSyncModule from "../../modules/background-sync";
import { backgroundSyncWork } from "./background-work";
import { getMobileSyncSnapshot, syncMobileNow } from "./mobile-sync";

export function activateMobileBackgroundSync(): {
  refresh: () => void;
  stop: () => void;
} {
  const native = BackgroundSyncModule;
  if (!native) return { refresh: () => {}, stop: () => {} };

  let stopped = false;
  let lastReported = "";

  const report = (action: string, work: Promise<void>) => {
    work.catch((error: unknown) =>
      captureOperationalError(error, {
        operation: `background_sync_${action}`,
        level: "warning",
      }),
    );
  };

  const refresh = () => {
    if (stopped) return;
    report(
      "refresh",
      countDueMobileAttachmentUploads().then(async (uploads) => {
        if (stopped) return;
        const work = backgroundSyncWork(getMobileSyncSnapshot(), uploads);
        const key = `${work.remaining}:${work.subtitle}`;
        if (key === lastReported) return;
        lastReported = key;
        await native.setPendingWork(work.remaining, work.subtitle);
      }),
    );
  };

  const flush = async () => {
    requestMobileAttachmentUploads();
    try {
      await syncMobileNow();
    } finally {
      refresh();
      if (!stopped) await native.finishBackgroundFlush();
    }
  };

  report("enable", native.setEnabled(true));
  const subscription = AppState.addEventListener("change", (nextState) => {
    if (nextState === "background") report("flush", flush());
  });
  refresh();

  return {
    refresh,
    stop: () => {
      stopped = true;
      subscription.remove();
      report("disable", native.setEnabled(false));
    },
  };
}
