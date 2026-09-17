import { config } from "../../config.js";

const ACCEPTED_EXTENSIONS = [".mp4", ".mov", ".mkv"];

export interface DriveFile {
  id: string;
  name: string;
  sizeBytes: number | null;
  md5Checksum: string | null;
  mimeType: string;
}

interface DriveFilesListResponse {
  files: Array<{ id: string; name: string; size?: string; md5Checksum?: string; mimeType: string }>;
  nextPageToken?: string;
}

/**
 * Lists files in a public Drive folder using a plain API key — no OAuth, no
 * service account, per docs/API_CONTRACTS.md ("Footage folder (Google
 * Drive)"). Works for folders shared "anyone with the link can view."
 * Paginates through all pages.
 */
export async function listDriveFolderFiles(folderId: string): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", `'${folderId}' in parents and trashed = false`);
    url.searchParams.set("key", config.GOOGLE_API_KEY);
    url.searchParams.set("fields", "nextPageToken, files(id,name,size,md5Checksum,mimeType)");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Drive API files.list for folder ${folderId} returned HTTP ${res.status}: ${body}`);
    }
    const data = (await res.json()) as DriveFilesListResponse;

    for (const f of data.files) {
      files.push({
        id: f.id,
        name: f.name,
        sizeBytes: f.size ? Number(f.size) : null,
        md5Checksum: f.md5Checksum ?? null,
        mimeType: f.mimeType,
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return files;
}

export function isAcceptedVideoFile(file: DriveFile): boolean {
  const lower = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Share-link form OpusClip's documented Google Drive support consumes — see docs/API_CONTRACTS.md. */
export function driveFileShareUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;
}
