import { lazy, Suspense, useState } from "react";

import {
  type SharedAttachmentResolver,
  SharedNoteDocument,
} from "@/components/shared-note-document";
import { useMountEffect } from "@/hooks/useMountEffect";
import { hasUnsupportedSharedNoteInteractiveNode } from "@/lib/shared-note-interactivity";
import {
  type SharedNoteSnapshot,
  withoutDuplicateLeadingTitle,
} from "@/lib/shared-notes";

const SharedNoteReadSurface = lazy(() =>
  import("@/components/shared-note-read-surface").then((module) => ({
    default: module.SharedNoteReadSurface,
  })),
);

const SharedNoteLiveSurface = lazy(() =>
  import("@/components/shared-note-live-surface").then((module) => ({
    default: module.SharedNoteLiveSurface,
  })),
);

export function SharedNoteReader({
  canCompose,
  excludedAttachmentIds,
  liveEditing = false,
  manageAccess,
  resolveAttachment,
  shareId,
  signedIn,
  snapshot,
}: {
  canCompose: boolean;
  excludedAttachmentIds?: readonly string[];
  /** Explicit editors join the live document instead of the read surface. */
  liveEditing?: boolean;
  manageAccess: boolean;
  resolveAttachment?: SharedAttachmentResolver;
  shareId: string;
  signedIn: boolean;
  snapshot: SharedNoteSnapshot;
}) {
  const [interactive, setInteractive] = useState(false);
  useMountEffect(() => setInteractive(true));

  const staticDocument = (
    <SharedNoteDocument
      attachments={snapshot.attachments}
      document={withoutDuplicateLeadingTitle(snapshot.body, snapshot.title)}
      excludedAttachmentIds={excludedAttachmentIds}
      resolveAttachment={resolveAttachment}
    />
  );

  if (!interactive || hasUnsupportedSharedNoteInteractiveNode(snapshot.body)) {
    return staticDocument;
  }

  if (liveEditing && signedIn) {
    return (
      <Suspense fallback={staticDocument}>
        <SharedNoteLiveSurface
          key={snapshot.shareId}
          canCompose={canCompose}
          excludedAttachmentIds={excludedAttachmentIds}
          manageAccess={manageAccess}
          resolveAttachment={resolveAttachment}
          shareId={shareId}
          snapshot={snapshot}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={staticDocument}>
      <SharedNoteReadSurface
        key={`${snapshot.shareId}:${snapshot.contentRevision}`}
        canCompose={canCompose}
        excludedAttachmentIds={excludedAttachmentIds}
        manageAccess={manageAccess}
        resolveAttachment={resolveAttachment}
        shareId={shareId}
        signedIn={signedIn}
        snapshot={snapshot}
      />
    </Suspense>
  );
}
