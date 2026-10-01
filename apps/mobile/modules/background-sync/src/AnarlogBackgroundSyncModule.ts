import { NativeModule, requireOptionalNativeModule } from "expo";

declare class AnarlogBackgroundSyncModule extends NativeModule {
  setEnabled(enabled: boolean): Promise<void>;
  setPendingWork(remaining: number, subtitle: string): Promise<void>;
  finishBackgroundFlush(): Promise<void>;
}

export default requireOptionalNativeModule<AnarlogBackgroundSyncModule>(
  "AnarlogBackgroundSync",
);
