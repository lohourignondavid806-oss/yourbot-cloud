import { isCanonicalInviteUrl } from "@openbot/contracts/invite-links";
import { INPUT_LIMITS } from "@openbot/contracts/input-limits";
import { Effect, Schema } from "effect";
import {
  renderContactMessageEmail,
  renderSignInCodeEmail,
  renderTeamInviteEmail,
  renderWelcomeEmail,
  type RenderedEmail,
} from "./email-templates";
import type {
  SmtpContactMessage,
  SmtpEmailMessage,
  SmtpTeamInviteMessage,
  SmtpWelcomeMessage,
} from "./smtp-email-delivery";

const BREVO_TRANSACTIONAL_EMAIL_URL = "https://api.brevo.com/v3/smtp/email";
const BREVO_TIMEOUT_MS = 10_000;
const EMAIL_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/iu;

export interface BrevoEmailBindings {
  BREVO_API_KEY?: string;
  BREVO_SENDER_EMAIL?: string;
  BREVO_SENDER_NAME?: string;
}

export class BrevoEmailError extends Schema.TaggedError<BrevoEmailError>()("BrevoEmailError", {
  message: Schema.String,
}) {}

export interface BrevoEmailDelivery {
  sendCode(message: SmtpEmailMessage): Effect.Effect<void, BrevoEmailError>;
  sendTeamInvite(message: SmtpTeamInviteMessage): Effect.Effect<void, BrevoEmailError>;
  sendContactMessage(message: SmtpContactMessage): Effect.Effect<void, BrevoEmailError>;
  sendWelcome(message: SmtpWelcomeMessage): Effect.Effect<void, BrevoEmailError>;
}

type BrevoFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export function createBrevoEmailDelivery(
  bindings: BrevoEmailBindings,
  fetchImpl: BrevoFetch = fetch,
): BrevoEmailDelivery {
  const config = readBrevoConfig(bindings);
  const send = (recipient: string, content: RenderedEmail, replyTo?: string) =>
    sendBrevoEmail(config, recipient, content, replyTo, fetchImpl);

  return {
    sendCode: (message) => {
      validateEmail(message.email, "recipient");
      if (!/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/u.test(message.code)) {
        throw new BrevoEmailError({ message: "brevo_invalid_code" });
      }
      return send(
        message.email,
        renderSignInCodeEmail({
          code: message.code,
          expiresInMinutes: Math.max(1, Math.ceil((message.expiresAt - Date.now()) / 60_000)),
        }),
      );
    },
    sendTeamInvite: (message) => {
      validateEmail(message.email, "recipient");
      validateEmail(message.inviterEmail, "inviter");
      if (
        !message.serverName.trim() ||
        message.serverName.length > INPUT_LIMITS.serverName ||
        hasHeaderBreak(message.serverName) ||
        !isCanonicalInviteUrl(message.inviteUrl)
      ) {
        throw new BrevoEmailError({ message: "brevo_invalid_invitation" });
      }
      return send(
        message.email,
        renderTeamInviteEmail({
          inviterEmail: message.inviterEmail,
          serverName: message.serverName,
          inviteUrl: message.inviteUrl,
          role: message.role,
        }),
      );
    },
    sendContactMessage: (message) => {
      validateEmail(message.email, "reply_to");
      return send(config.senderEmail, renderContactMessageEmail(message), message.email);
    },
    sendWelcome: (message) => {
      if (
        !message.serverName.trim() ||
        message.serverName.length > INPUT_LIMITS.serverName ||
        hasHeaderBreak(message.serverName)
      ) {
        throw new BrevoEmailError({ message: "brevo_invalid_server_name" });
      }
      validateEmail(message.email, "recipient");
      return send(message.email, renderWelcomeEmail({ plan: message.plan, serverName: message.serverName }));
    },
  };
}

interface BrevoConfig {
  apiKey: string;
  senderEmail: string;
  senderName: string;
}

function readBrevoConfig(bindings: BrevoEmailBindings): BrevoConfig {
  const apiKey = bindings.BREVO_API_KEY?.trim();
  const senderEmail = bindings.BREVO_SENDER_EMAIL?.trim();
  const senderName = bindings.BREVO_SENDER_NAME?.trim();
  if (!apiKey || !senderEmail || !senderName) throw new Error("Brevo email configuration is incomplete.");
  validateEmail(senderEmail, "sender");
  if (hasHeaderBreak(senderName) || senderName.length > 120) throw new Error("Invalid Brevo sender name.");
  return { apiKey, senderEmail, senderName };
}

function sendBrevoEmail(
  config: BrevoConfig,
  recipient: string,
  content: RenderedEmail,
  replyTo: string | undefined,
  fetchImpl: BrevoFetch,
): Effect.Effect<void, BrevoEmailError> {
  return Effect.tryPromise({
    try: (signal) =>
      fetchImpl(BREVO_TRANSACTIONAL_EMAIL_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "api-key": config.apiKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sender: { email: config.senderEmail, name: config.senderName },
          to: [{ email: recipient }],
          subject: content.subject,
          htmlContent: content.html,
          textContent: content.text,
          ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(BREVO_TIMEOUT_MS)]),
      }),
    catch: () => new BrevoEmailError({ message: "email_delivery_unknown" }),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.ok) return Effect.void;
      if (response.status === 429) return Effect.fail(new BrevoEmailError({ message: "email_delivery_rate_limited" }));
      if (response.status === 408 || response.status >= 500) {
        return Effect.fail(new BrevoEmailError({ message: "email_delivery_unknown" }));
      }
      if (response.status === 401 || response.status === 403) {
        return Effect.fail(new BrevoEmailError({ message: "brevo_auth_failed" }));
      }
      return Effect.fail(new BrevoEmailError({ message: "brevo_delivery_failed" }));
    }),
  );
}

function validateEmail(value: string, field: string): void {
  if (value.length > INPUT_LIMITS.email || hasHeaderBreak(value) || !EMAIL_PATTERN.test(value)) {
    throw new BrevoEmailError({ message: `brevo_invalid_${field}` });
  }
}

function hasHeaderBreak(value: string): boolean {
  return value.includes("\r") || value.includes("\n");
}
