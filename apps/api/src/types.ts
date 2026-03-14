import type { FastifyInstance } from "fastify";
import type { Database } from "@hl-copy/db";

declare module "fastify" {
  interface FastifyInstance {
    db: Database;
  }
}
