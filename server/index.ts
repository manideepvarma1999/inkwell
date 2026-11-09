import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app";

const here = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production" || process.argv.includes("--production");

const app = createApp({
  dataDir: process.env.DATA_DIR ?? path.join(process.cwd(), "data"),
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean),
  staticDir: production ? (process.env.STATIC_DIR ?? path.resolve(here, "../dist/web")) : undefined,
  trustProxy: process.env.TRUST_PROXY === "true",
});

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
app.server.listen(port, host, () => console.log(`inkwell listening on http://${host}:${port}`));

const shutdown = async () => {
  console.log("saving boards and shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
