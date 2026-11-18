import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { CanvasController } from "./canvas.controller";
import { CanvasBoard, CanvasBoardSchema } from "./canvas.schema";
import { CanvasService } from "./canvas.service";

/** Creative Canvas boards of the Social Media workspace */
@Module({
  imports: [MongooseModule.forFeature([{ name: CanvasBoard.name, schema: CanvasBoardSchema }])],
  controllers: [CanvasController],
  providers: [CanvasService],
})
export class CanvasModule {}
