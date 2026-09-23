// Delivers a message to the person running the pipeline via NOTIFY_WEBHOOK_URL:
// a Slack incoming webhook or a Discord webhook (detected from the URL). One
// channel for v1. A failed delivery throws, so callers don't record a
// notification as sent when it wasn't.

export type NotifierDeps = { webhookUrl: string; fetch?: typeof fetch };

export class NotifyError extends Error {
  readonly code = "notify_failed";
  constructor(message: string) {
    super(message);
    this.name = "NotifyError";
  }
}

/** Discord rejects content over 2000 characters; Slack allows far more. Stay under both. */
export const MAX_MESSAGE_CHARS = 1900;

const isDiscord = (url: string) => /(^|\.)discord(app)?\.com$/i.test(new URL(url).hostname);

export function truncate(message: string, max = MAX_MESSAGE_CHARS): string {
  return message.length <= max ? message : `${message.slice(0, max - 20).trimEnd()}\n… (truncated)`;
}

export async function sendNotification(deps: NotifierDeps, message: string): Promise<{ delivered: true; status: number; chars: number }> {
  const text = truncate(message.trim());
  if (!text) throw new NotifyError("Nothing to send: the message is empty");
  const body = isDiscord(deps.webhookUrl) ? { content: text } : { text };
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(deps.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new NotifyError(`Couldn't reach the notification webhook: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new NotifyError(`Notification webhook answered HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return { delivered: true, status: res.status, chars: text.length };
}
