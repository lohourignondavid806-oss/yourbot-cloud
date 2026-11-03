import { createInviteUrl } from "@openbot/contracts/invite-links";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { NO_ACCOUNT_ANALYTICS } from "../src/server/account-analytics";
import {
  createBrevoEmailDelivery,
  type BrevoEmailBindings,
} from "../src/server/brevo-email-delivery";
import { createEmailCodeDelivery, type EmailDeliveryBindings } from "../src/server/email-delivery";

const bindings: BrevoEmailBindings = {
  BREVO_API_KEY: "brevo-test-key",
  BREVO_SENDER_EMAIL: "noreply@yourbot.tech",
  BREVO_SENDER_NAME: "YourBot",
};

function response(status: number): Response {
  return new Response(status === 201 ? JSON.stringify({ messageId: "test-message" }) : null, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function captureFetch(status = 201) {
  const requests: Array<{ input: string | URL; init: RequestInit | undefined }> = [];
  const fetchMock = async (input: string | URL, init?: RequestInit) => {
    requests.push({ input, init });
    return response(status);
  };
  return { fetchMock, requests };
}

function payload(request: { init: RequestInit | undefined } | undefined): Record<string, any> {
  if (!request) throw new Error("Expected captured Brevo request.");
  return JSON.parse(String(request.init?.body));
}

describe("Brevo email delivery", () => {
  it("maps all four OpenBot email categories to Brevo transactional messages", async () => {
    const { fetchMock, requests } = captureFetch();
    const delivery = createBrevoEmailDelivery(bindings, fetchMock);
    const inviteUrl = createInviteUrl({
      apiUrl: "https://api.openbot.run/",
      serverId: "00000000-0000-4000-8000-000000000001",
      fingerprint: "A".repeat(32),
      token: "B".repeat(32),
    });

    await Effect.runPromise(delivery.sendCode({ email: "user@example.com", code: "ABCD-EFGH", expiresAt: Date.now() }));
    await Effect.runPromise(
      delivery.sendTeamInvite({
        email: "invitee@example.com",
        inviterEmail: "owner@example.com",
        serverName: "Workspace",
        inviteUrl,
        role: "member",
      }),
    );
    await Effect.runPromise(
      delivery.sendContactMessage({
        name: "Visitor",
        email: "visitor@example.com",
        company: null,
        topic: "general",
        message: "Hello",
      }),
    );
    await Effect.runPromise(
      delivery.sendWelcome({ email: "subscriber@example.com", plan: "starter", serverName: "Workspace" }),
    );

    expect(requests).toHaveLength(4);
    expect(requests.every(({ input }) => input === "https://api.brevo.com/v3/smtp/email")).toBe(true);
    expect(requests.every(({ init }) => (init?.headers as Record<string, string>)["api-key"] === "brevo-test-key")).toBe(
      true,
    );
    expect(payload(requests[0]).to).toEqual([{ email: "user@example.com" }]);
    expect(payload(requests[0]).textContent).toContain("ABCD-EFGH");
    expect(payload(requests[1]).to).toEqual([{ email: "invitee@example.com" }]);
    expect(payload(requests[2]).replyTo).toEqual({ email: "visitor@example.com" });
    expect(payload(requests[3]).to).toEqual([{ email: "subscriber@example.com" }]);
    expect(JSON.stringify(payload(requests[0]))).not.toContain("brevo-test-key");
  });

  it("selects Brevo without requiring SMTP variables", () => {
    const delivery = createEmailCodeDelivery(
      {
        EMAIL_PROVIDER: "brevo",
        ...bindings,
      } satisfies EmailDeliveryBindings,
      NO_ACCOUNT_ANALYTICS,
    );
    expect(delivery).not.toBeNull();
  });

  it("maps provider throttling and ambiguous failures without retrying", async () => {
    const throttled = createBrevoEmailDelivery(bindings, async () => response(429));
    await expect(
      Effect.runPromise(
        throttled.sendCode({ email: "user@example.com", code: "ABCD-EFGH", expiresAt: Date.now() }),
      ),
    ).rejects.toMatchObject({ message: "email_delivery_rate_limited" });

    let calls = 0;
    const unavailable = createBrevoEmailDelivery(bindings, async () => {
      calls += 1;
      return response(503);
    });
    await expect(
      Effect.runPromise(
        unavailable.sendCode({ email: "user@example.com", code: "ABCD-EFGH", expiresAt: Date.now() }),
      ),
    ).rejects.toMatchObject({ message: "email_delivery_unknown" });
    expect(calls).toBe(1);
  });

  it("maps transport failures and timeouts to an ambiguous delivery error", async () => {
    const delivery = createBrevoEmailDelivery(bindings, async () => {
      throw new Error("network failure");
    });
    await expect(
      Effect.runPromise(
        delivery.sendCode({ email: "user@example.com", code: "ABCD-EFGH", expiresAt: Date.now() }),
      ),
    ).rejects.toMatchObject({ message: "email_delivery_unknown" });
  });

  it("rejects invalid Brevo configuration before an API call", () => {
    expect(() => createBrevoEmailDelivery({ BREVO_API_KEY: "key" })).toThrow(
      "Brevo email configuration is incomplete.",
    );
  });
});
