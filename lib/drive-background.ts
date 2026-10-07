import { after } from "next/server";
import { driveMode } from "./db";
import { processDriveJobs } from "./drive-sync";

/** The database is the queue; browser lifetime does not control delivery. */
export function scheduleDriveUpload(): void {
  if (driveMode() !== "google") return;
  after(async () => {
    try { await processDriveJobs({ limit: 1 }); }
    catch { console.error(JSON.stringify({ event: "oddshot_drive_dispatch_failed" })); }
  });
}
