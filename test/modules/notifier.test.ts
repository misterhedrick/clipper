import { describe, expect, it, vi } from "vitest";
import { MAX_MESSAGE_CHARS, NotifyError, sendNotification, truncate } from "../../src/modules/notifier/index.js";

const capture = (status = 200) => {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(status === 200 ? "ok" : "invalid_token", { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};

describe("sendNotification", () => {
  it("posts {text} to Slack and {content} to Discord", async () => {
    const slack = capture();
    await sendNotification({ webhookUrl: "https://hooks.slack.com/services/T/B/X", fetch: slack.fetchImpl }, "hi");
    expect(slack.calls[0]!.body).toEqual({ text: "hi" });
    const discord = capture();
    await sendNotification({ webhookUrl: "https://discord.com/api/webhooks/1/abc", fetch: discord.fetchImpl }, "hi");
    expect(discord.calls[0]!.body).toEqual({ content: "hi" });
  });

  it("truncates long messages under Discord's limit", async () => {
    const d = capture();
    await sendNotification({ webhookUrl: "https://discord.com/api/webhooks/1/abc", fetch: d.fetchImpl }, "x".repeat(5000));
    const content = (d.calls[0]!.body as { content: string }).content;
    expect(content.length).toBeLessThanOrEqual(MAX_MESSAGE_CHARS);
    expect(content.endsWith("… (truncated)")).toBe(true);
    expect(truncate("short")).toBe("short");
  });

  it("throws on a failed delivery or an empty message", async () => {
    const bad = capture(403);
    await expect(sendNotification({ webhookUrl: "https://hooks.slack.com/x", fetch: bad.fetchImpl }, "hi")).rejects.toThrow(/HTTP 403: invalid_token/);
    const down = vi.fn(async () => {
      throw new TypeError("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(sendNotification({ webhookUrl: "https://hooks.slack.com/x", fetch: down }, "hi")).rejects.toBeInstanceOf(NotifyError);
    await expect(sendNotification({ webhookUrl: "https://hooks.slack.com/x", fetch: capture().fetchImpl }, "  ")).rejects.toThrow(/empty/);
  });
});
