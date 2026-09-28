import html from "./index.html";
import css from "./style.css";
import js from "./app.client.js";
import logo from "../../site/public/favicon.svg";
import { handle, type Env } from "./handler";

const assets = {
  "/": { body: html, type: "text/html; charset=utf-8" },
  "/style.css": { body: css, type: "text/css; charset=utf-8" },
  "/app.js": { body: js, type: "text/javascript; charset=utf-8" },
  "/favicon.svg": { body: logo, type: "image/svg+xml" },
};
export default {
  fetch: (request, env, ctx) => handle(request, env, ctx.access, assets),
} satisfies ExportedHandler<Env>;
