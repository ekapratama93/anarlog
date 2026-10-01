import { AppState } from "react-native";

import { activateMobileAttachmentUploads } from "@/attachment-sync/upload-runner";
import { retryPendingTranscriptions } from "@/data/transcribe";
import { useMountEffect } from "@/lib/use-mount-effect";
import { shouldSyncAfterAppStateChange } from "@/sync/app-state";
import { activateMobileBackgroundSync } from "@/sync/background-sync";
import {
  activateMobileSync,
  getMobileSyncSnapshot,
  subscribeMobileSync,
  syncMobileNow,
} from "@/sync/mobile-sync";

export function MobileSyncLifecycle({
  accessToken,
  accountUserId,
  syncEnabled,
}: {
  accessToken: string;
  accountUserId: string;
  syncEnabled: boolean;
}) {
  useMountEffect(() => {
    const deactivate = syncEnabled
      ? activateMobileSync({ accessToken, accountUserId })
      : () => {};
    const background = syncEnabled
      ? activateMobileBackgroundSync()
      : { refresh: () => {}, stop: () => {} };
    const uploads = activateMobileAttachmentUploads({
      accessToken,
      onActivity: background.refresh,
    });
    let transcriptionRetryTimer: ReturnType<typeof setInterval> | undefined;
    let syncWasReady = false;
    const retryPending = () => {
      if (
        AppState.currentState === "active" &&
        getMobileSyncSnapshot().hasRecoveryKey
      ) {
        void retryPendingTranscriptions();
      }
    };
    const updateUploads = () => {
      const sync = getMobileSyncSnapshot();
      const syncReady = sync.phase === "ready" && sync.running;
      if (syncReady) {
        uploads.resume();
      } else {
        uploads.pause();
      }
      if (syncReady && !syncWasReady) retryPending();
      syncWasReady = syncReady;
      background.refresh();
    };
    const unsubscribeSync = subscribeMobileSync(updateUploads);
    let previousState = AppState.currentState;
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (shouldSyncAfterAppStateChange(previousState, nextState)) {
        void syncMobileNow();
        retryPending();
      }
      previousState = nextState;
    });
    updateUploads();
    retryPending();
    transcriptionRetryTimer = setInterval(retryPending, 60_000);

    return () => {
      if (transcriptionRetryTimer) clearInterval(transcriptionRetryTimer);
      subscription.remove();
      unsubscribeSync();
      uploads.stop();
      background.stop();
      deactivate();
    };
  });
  return null;
}
