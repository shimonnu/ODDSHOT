import {
  assignDriveFileIds, claimDriveJob, completeDriveJob, driveMode, failDriveJob, getDrivePhotoPayload,
} from "./db";
import { getDriveCredentials } from "./drive-auth";
import { generateDriveFileIds, GoogleDriveError, refreshGoogleAccessToken, syncDrivePhoto } from "./google-drive";

export type DriveSyncResult = { processed: number; synced: number; failed: number; paused?: "demo" | "disconnected" };

/** Jobs and file IDs persist in D1; memory is never used as an upload lock. */
export async function processDriveJobs(options: { limit?: number } = {}): Promise<DriveSyncResult> {
  const result: DriveSyncResult = { processed: 0, synced: 0, failed: 0 };
  if (driveMode() !== "google") return { ...result, paused: "demo" };
  const connection = await getDriveCredentials();
  if (!connection) return { ...result, paused: "disconnected" };
  const limit = Math.max(1, Math.min(5, Math.trunc(options.limit ?? 1) || 1));
  const started = Date.now();
  for (let index = 0; index < limit; index++) {
    if (index > 0 && Date.now() - started > 120_000) break;
    const job = await claimDriveJob();
    if (!job) break;
    result.processed++;
    try {
      const payload = { ...await getDrivePhotoPayload(job.photoId), folderId: connection.folderId };
      let ids = job.imageFileId && job.metadataFileId ? { imageFileId: job.imageFileId, metadataFileId: job.metadataFileId } : null;
      if (!ids) {
        if (job.imageFileId || job.metadataFileId) throw new GoogleDriveError("Google Drive の保存設定を確認してください。", "configuration");
        const accessToken = await refreshGoogleAccessToken(connection.credentials);
        const generated = await generateDriveFileIds(accessToken, 2);
        ids = { imageFileId: generated[0], metadataFileId: generated[1] };
        // A process can stop after either upload. Future workers retain these IDs and update the same files.
        if (!await assignDriveFileIds(job, ids)) continue;
      }
      await syncDrivePhoto(connection.credentials, payload, ids);
      if (await completeDriveJob(job)) result.synced++;
    } catch (error) {
      const known = error instanceof GoogleDriveError;
      await failDriveJob(job, known ? error.message : "Google Drive の保存処理を完了できませんでした。再試行します。", { retryable: !known || error.retryable });
      result.failed++;
      // An expired owner grant cannot be repaired by repeatedly uploading other photos.
      if (known && (error.reconnectRequired || ["configuration", "permission", "not_found"].includes(error.code))) break;
    }
  }
  return result;
}
