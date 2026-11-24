import { z } from "zod";

export const accountSettingsSchema = z
  .strictObject({
    explorer: z.enum(["suivision", "suiscan"]),
    theme: z.enum(["system", "dark", "light"]),
  })
  .meta({
    $id: "https://blast-v2.invalid/presale/contracts/account-settings-request.schema.json",
    title: "Account settings update",
    description: "PUT /api/account/settings (CL-8).",
  });

export type AccountSettings = z.infer<typeof accountSettingsSchema>;
