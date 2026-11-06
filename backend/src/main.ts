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
  // the studio names the brand it works for: Claude usage is billed to it
  app.use((req: any, _res: any, next: () => void) => {
    const b = req.headers["x-brand-id"];
    usageScope.run({ brandId: typeof b === "string" && /^[\w-]{1,64}$/.test(b) ? b : undefined }, next);
  });
  
app.enableCors({
  // plus any origins listed in CORS_ORIGIN (comma-separated), e.g. a preview deployment
  origin: [
    "https://boga-workspace.vercel.app",
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
