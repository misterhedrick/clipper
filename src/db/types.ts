export type CampaignStatus =
  | "discovered"
  | "ingesting"
  | "requirements_drafted"
  | "pending_confirmation"
  | "active"
  | "paused"
  | "archived";

export type SourceJobStatus =
  | "detected"
  | "validating"
  | "validation_failed"
  | "queued"
  | "submitting"
  | "submit_failed"
  | "project_created"
  | "processing"
  | "candidates_ready"
  | "needs_attention"
  | "completed";

export type CandidateClipStatus =
  | "generated"
  | "checking"
  | "awaiting_review"
  | "needs_edit"
  | "approved"
  | "exporting"
  | "ready_to_post"
  | "posted"
  | "rejected"
  | "archived";

export type CheckResult = "pass" | "fail" | "manual_review_required";

/** Mirrors docs/DATA_MODEL.md § CampaignConfig shape, stored in campaigns.config */
export interface CampaignConfig {
  clipGeneration: {
    brandTemplateId?: string;
    aspectRatio: "portrait" | "landscape" | "square";
    minDurationSeconds: number;
    maxDurationSeconds: number;
    originalAudioOnly: boolean;
    captionsEnabled: boolean;
  };
  requirements: {
    requiredOverlayAssetIds: string[];
    requiredOnScreenText: string[];
    requiredCaptionLines: string[];
    requiredTags: string[];
    disclosureLines: string[];
    maxAdditionalHashtags: number;
  };
  review: {
    requiredChecks: string[];
    autoApprove: false;
  };
  extraction: {
    fieldConfidence: Record<string, "high" | "low">;
    unresolvedFields: string[];
  };
}

export interface Campaign {
  id: string;
  created_at: Date;
  updated_at: Date;
  content_rewards_campaign_id: string;
  content_rewards_url: string;
  title: string | null;
  brand: string | null;
  platforms: string[];
  guideline_doc_url: string | null;
  drive_folder_url: string | null;
  drive_folder_id: string | null;
  status: CampaignStatus;
  config: CampaignConfig;
  config_confirmed_at: Date | null;
  config_confirmed_by: string | null;
}

export interface SourceJob {
  id: string;
  created_at: Date;
  updated_at: Date;
  campaign_id: string;
  drive_file_id: string;
  drive_file_name: string | null;
  size_bytes: number | null;
  md5_checksum: string | null;
  source_url: string;
  status: SourceJobStatus;
  status_reason: string | null;
  opusclip_project_id: string | null;
  retry_count: number;
}

export interface CandidateClip {
  id: string;
  created_at: Date;
  updated_at: Date;
  source_job_id: string;
  opusclip_clip_id: string;
  title: string | null;
  duration_ms: number | null;
  preview_url: string | null;
  export_url: string | null;
  hashtags: string | null;
  status: CandidateClipStatus;
  check_results: Record<string, CheckResult>;
}

export type EntityType = "campaign" | "source_job" | "candidate_clip";
