import { Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";

/** Ids of every footage record a design, a saved version, a template or a brand still points to (any 24-hex id in the document) */
@Injectable()
export class FootageRefs {
  constructor(@InjectConnection() private db: Connection) {}
  async used(): Promise<Set<string>> {
    const ids = new Set<string>(), re = /[0-9a-f]{24}/g;
    for (const name of ["social_designs", "social_design_versions", "social_templates", "social_brands"]) {
      for await (const doc of this.db.collection(name).find({}, { projection: { _id: 0 } })) for (const m of JSON.stringify(doc).matchAll(re)) ids.add(m[0]);
    }
    return ids;
  }
}
