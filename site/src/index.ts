import { EmailMessage } from "cloudflare:email";
import { media } from "./media";
import { signup } from "./signup";
interface Env {
  ASSETS: Fetcher;
  MEDIA: R2Bucket;
  SITE_TELEMETRY?: AnalyticsEngineDataset;
  BETA_EMAIL: SendEmail;
  BETA_DELIVERY_TO: string;
  BETA_LIMIT: RateLimit;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/media/")) return media(request, env.MEDIA);
    // The not-found page is the file 404.html, so the assets served it at
    // /404 as an ordinary page with a 200, and sent /404.html there with a
    // 307: a soft 404 at the one address that names it (pre-release bug hunt,
    // B98). Both are answered with that page and a real 404. It is asked for
    // as a plain GET, so no conditional header turns it into a 304.
    if (pathname === "/404" || pathname === "/404.html") {
      const page = await env.ASSETS.fetch(new URL("/404", request.url));
      return new Response(page.body, { status: 404, headers: page.headers });
    }
    if (pathname !== "/api/ios-beta") return env.ASSETS.fetch(request);
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
