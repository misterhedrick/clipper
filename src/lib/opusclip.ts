import { config } from "../config.js";
import type { CampaignConfig } from "../db/types.js";

const BASE_URL = "https://api.opus.pro";

async function opusClipFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.OPUSCLIP_API_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

export class OpusClipError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string,
    /** Best-effort classification — see docs/API_CONTRACTS.md § Create a clip project. */
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface CreateProjectInput {
  videoUrl: string;
  campaignConfig: CampaignConfig;
  webhookUrl: string;
  sourceJobId: string;
}

export interface CreateProjectResult {
  projectId: string;
}

/**
 * POST /api/clip-projects — see docs/API_CONTRACTS.md. The exact response
 * shape isn't documented beyond "includes a project id"; this reads the
 * first id-shaped field it finds (id or projectId) and throws clearly if
 * neither is present, rather than silently returning undefined.
 */
export async function createClipProject(input: CreateProjectInput): Promise<CreateProjectResult> {
  const body = {
    videoUrl: input.videoUrl,
    brandTemplateId: input.campaignConfig.clipGeneration.brandTemplateId,
    curationPref: {
      durationRange: {
        min: input.campaignConfig.clipGeneration.minDurationSeconds,
        max: input.campaignConfig.clipGeneration.maxDurationSeconds,
      },
    },
    renderPref: {
      aspectRatio: input.campaignConfig.clipGeneration.aspectRatio,
      captions: input.campaignConfig.clipGeneration.captionsEnabled,
    },
    conclusionActions: [{ type: "webhook", url: input.webhookUrl }],
    uploadedVideoAttr: { title: `source_job:${input.sourceJobId}` },
  };

  const res = await opusClipFetch("/api/clip-projects", { method: "POST", body: JSON.stringify(body) });
  const responseText = await res.text();

  if (!res.ok) {
    // 4xx that isn't a rate limit is treated as permanent (bad request, insufficient
    // credits, rejected URL); 429 and 5xx are retryable. See docs/API_CONTRACTS.md
    // "Failure handling" — OpusClip doesn't enumerate exact error codes, so this
    // classification should be tuned from real response bodies once available.
    const retryable = res.status === 429 || res.status >= 500;
    throw new OpusClipError(`POST /api/clip-projects failed with HTTP ${res.status}`, res.status, responseText, retryable);
  }

  const parsed = JSON.parse(responseText) as Record<string, unknown>;
  const projectId = (parsed.id ?? parsed.projectId) as string | undefined;
  if (!projectId) {
    throw new OpusClipError("Create-project response had no id/projectId field", res.status, responseText, false);
  }
  return { projectId };
}

export interface ExportableClip {
  id: string;
  projectId: string;
  title: string | null;
  durationMs: number | null;
  uriForPreview: string | null;
  uriForExport: string | null;
  hashtags: string | null;
}

/** GET /api/exportable-clips?q=findByProjectId&projectId=... — see docs/API_CONTRACTS.md. */
export async function getExportableClips(projectId: string): Promise<ExportableClip[]> {
  const url = `/api/exportable-clips?q=findByProjectId&projectId=${encodeURIComponent(projectId)}&pageNum=1&pageSize=50`;
  const res = await opusClipFetch(url, { method: "GET" });
  const responseText = await res.text();

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new OpusClipError(`GET /api/exportable-clips failed with HTTP ${res.status}`, res.status, responseText, retryable);
  }

  const parsed = JSON.parse(responseText) as ExportableClip[] | { data: ExportableClip[] };
  return Array.isArray(parsed) ? parsed : parsed.data;
}
