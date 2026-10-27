import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const hostContract = defineRpcContract({
  prepareClaude: {
    input: z.object({ executable: z.string() }).strict(),
    output: z.object({ launcher: z.string(), executable: z.string() }).strict(),
  },
});
