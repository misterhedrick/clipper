export interface CampaignMetadata {
  campaignId: string;
  contentRewardsUrl: string;
  title: string;
  brand: string | null;
  platforms: string[];
  payout: {
    cpmMinRateCents: number | null;
    cpmMaxRateCents: number | null;
    budgetCents: number | null;
  };
  guidelineDocUrl: string | null;
  driveFolderUrl: string | null;
  driveFolderId: string | null;
}
