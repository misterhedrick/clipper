import { config } from "../../config.js";

/**
 * Fires a Slack-compatible incoming webhook. Per BUILD_PLAN.md task 13 —
 * this module was explicitly called out as previously missing from the
 * original plan; a needs_attention transition or a stalled confirmation
 * must produce a real delivered alert, not just a log line.
 */
export async function notify(text: string): Promise<void> {
  const res = await fetch(config.NOTIFY_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    // Deliberately does not throw — a failed notification must not fail the
    // job/transition that triggered it. Logged so it's at least visible.
    // eslint-disable-next-line no-console
    console.error(`notify() failed: HTTP ${res.status} from NOTIFY_WEBHOOK_URL`);
  }
}

export async function notifyNeedsAttention(entityType: string, entityId: string, reason: string): Promise<void> {
  await notify(`:warning: *${entityType}* \`${entityId}\` needs attention: ${reason}`);
}

export async function notifyPendingConfirmationStale(campaignId: string, title: string | null, hoursWaiting: number): Promise<void> {
  await notify(
    `:hourglass: Campaign *${title ?? campaignId}* (\`${campaignId}\`) has been pending_confirmation for ${hoursWaiting}h — requirements need human review.`,
  );
}
