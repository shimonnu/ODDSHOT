import { after } from "next/server";
import { driveMode } from "./db";
import { processDriveJobs } from "./drive-sync";
import { processPhotoBackground } from "./photo-background";

/** Register the already-started title task so it survives the HTTP response on Vercel. */
export function schedulePhotoTitleCompletion(work?: Promise<void>): void {
  if (!work && driveMode() !== "google") return;
  after(() => processPhotoBackground(work, async () => {
    if (driveMode() === "google") await processDriveJobs({ limit: 1 });
  }, () => { console.error(JSON.stringify({ event: "oddshot_photo_background_failed" })); }));
}
