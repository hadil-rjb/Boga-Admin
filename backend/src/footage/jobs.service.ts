import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Footage, FootageDocument } from "./footage.schema";

/** Placeholder queue: Task 6 replaces the body with the real job runner. For now it only records the step as queued. */
@Injectable()
export class JobsService {
  constructor(@InjectModel(Footage.name) private model: Model<FootageDocument>) {}
  enqueue(footageId: string, step: string): void {
    void this.model.updateOne({ _id: footageId }, { $set: { [`jobs.${step}`]: { state: "queued", progress: 0 } } }).catch(() => undefined);
  }
}
