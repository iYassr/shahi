import { EmailMessage } from "cloudflare:email";
import { signup } from "./signup";
interface Env {
  ASSETS: Fetcher;
  SITE_TELEMETRY?: AnalyticsEngineDataset;
  BETA_EMAIL: SendEmail;
  BETA_DELIVERY_TO: string;
  BETA_LIMIT: RateLimit;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/api/ios-beta") return env.ASSETS.fetch(request);
    const started = Date.now();
    const response = await signup(request, {
      limit: async (key) => (await env.BETA_LIMIT.limit({ key })).success,
      send: async (email) => {
        // Deliver to the verified destination of support@'s existing routing rule.
        // Keep the public support alias in To and the applicant in Reply-To.
        const raw = [
          "From: Shahi Beta <beta@getshahi.dev>", "To: support@getshahi.dev",
          `Reply-To: ${email}`, "Subject: Shahi iOS beta signup",
          `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@getshahi.dev>`,
          "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: 8bit", "",
          `iOS TestFlight signup: ${email}`, "", "This person requested an invitation to the Shahi iOS beta.",
          "They agreed to receive email about the beta. No TestFlight invitation has been sent automatically.",
        ].join("\r\n");
        await env.BETA_EMAIL.send(new EmailMessage("beta@getshahi.dev", env.BETA_DELIVERY_TO, raw));
      },
    });
    const durationMs = Date.now() - started;
    try {
      env.SITE_TELEMETRY?.writeDataPoint({ blobs: ["signup_result"], doubles: [response.status, durationMs], indexes: ["signup_result"] });
      if (response.status >= 500 || Math.random() < 0.01) console.log({ service: "shahi-site", event: "signup_result", status: response.status, durationMs });
    } catch { /* Never log the applicant, form body or raw delivery error. */ }
    return response;
  },
} satisfies ExportedHandler<Env>;
