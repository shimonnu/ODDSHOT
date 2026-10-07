import type { Metadata } from "next";
import DriveAdmin from "./drive-admin";
import "./drive-admin.css";

export const metadata: Metadata = {
  title: "Google Drive 管理 | ODDSHOT",
  robots: { index: false, follow: false },
};

export default function DriveAdminPage() {
  return <DriveAdmin />;
}
