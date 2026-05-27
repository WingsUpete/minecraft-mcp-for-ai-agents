import * as z from "zod/v4";

export const Message = z
  .object({
    type: z
      .enum(["chat", "whisper"])
      .describe(
        "Whether this is a private message (whisper) or a public chat message (chat)",
      ),
    sender: z.string().describe("Sender of the message"),
    content: z.string().describe("Content of the message"),
  })
  .describe("A message received by the bot");

export type Message = z.infer<typeof Message>;
