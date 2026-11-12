import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { APP_GUARD } from "@nestjs/core";
import { ArticlesModule } from "./articles/articles.module";
import { GscModule } from "./gsc/gsc.module";
import { AuthModule } from "./auth/auth.module";
import { ShareModule } from "./share/share.module";
import { AiModule } from "./ai/ai.module";
import { FramerModule } from "./framer/framer.module";
import { MediaModule } from "./media/media.module";
import { SocialModule } from "./social/social.module";
import { FootageModule } from "./footage/footage.module";
import { JwtAuthGuard } from "./auth/jwt-auth.guard";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (c: ConfigService) => ({ uri: c.getOrThrow<string>("MONGODB_URI") }),
    }),
    AuthModule,
    ShareModule,
    AiModule,
    MediaModule,
    ArticlesModule,
    GscModule,
    FramerModule,
    SocialModule,
    FootageModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: JwtAuthGuard }], // tout est protégé sauf @Public()
})
export class AppModule {}
