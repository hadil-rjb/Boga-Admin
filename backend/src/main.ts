import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { usageScope } from "./ai/usage";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  // articles + social designs embed images as data URLs
  app.useBodyParser("json", { limit: process.env.BODY_LIMIT || "50mb" });
  app.setGlobalPrefix("api");
  // footage upload: 8 MB raw chunks, parsed for this route only
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { raw } = require("express"); // express ships with @nestjs/platform-express
  app.use("/api/footage/:id/chunk", raw({ type: "application/octet-stream", limit: "9mb" }));
  // a post's video (the studio's recording of an animated design): 8 MB raw chunks too
  app.use("/api/social/brands/:brandId/posts/:id/video/upload/:uploadId/:index", raw({ type: "application/octet-stream", limit: "9mb" }));
  // the studio names the brand it works for: Claude usage is billed to it
  app.use((req: any, _res: any, next: () => void) => {
    const b = req.headers["x-brand-id"];
    usageScope.run({ brandId: typeof b === "string" && /^[\w-]{1,64}$/.test(b) ? b : undefined }, next);
  });
  
app.enableCors({
  // plus any origins listed in CORS_ORIGIN (comma-separated), e.g. a preview deployment
  origin: [
    "https://boga-workspace.vercel.app",
    "https://www.boga.agency",
    "https://boga.agency",
    "http://localhost:3000",
    ...(process.env.CORS_ORIGIN || "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter(Boolean),
  ],
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // x-share-token: "anyone with the link" viewers authenticate with it (see auth/jwt-auth.guard.ts)
  allowedHeaders: ["Content-Type", "Authorization", "x-brand-id", "x-share-token"],
});
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT || 4000);
}
bootstrap();
