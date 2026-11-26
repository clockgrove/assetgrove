/**
 * A synthetic Assetgrove extension, `tuned`: its own settings (a binary path, a default size and a
 * tier, each with a default), and one adapter, `tuned:paint`, with a provider setting (`quality`)
 * and route options for `still`. Its provider is never called; it shows what core handed it.
 */
export default function extension(context) {
  const { z } = context;
  return {
    api: 3,
    name: "tuned",
    settingsSchema: z.strictObject({
      binary: z.string().default("/opt/tuned/bin/tuned"),
      size: z.number().int().positive().default(64),
      tier: z.enum(["fast", "best"]).default("fast"),
    }),
    adapters: [
      {
        id: "tuned:paint",
        capabilities: ["image"],
        fixedHosts: ["api.tuned.example"],
        endpointFromSettings: false,
        defaultKeyEnv: "TUNED_API_KEY",
        providerSettingsSchema: z.strictObject({
          quality: z.enum(["draft", "final"]).default("draft"),
        }),
        routeOptionsSchema: {
          still: z.strictObject({
            tuned: z.strictObject({ steps: z.number().int().min(1).max(50) }),
          }),
        },
        create(c) {
          const never = async () => {
            throw new Error("tuned:paint is never called");
          };
          return {
            seen: { pack: context.settings, adapter: c.adapterSettings },
            billing: {
              adapter: "tuned:paint",
              providerId: c.providerId,
              paid: true,
              hosts: ["api.tuned.example"],
              settle: "declared",
              reconcile: "unavailable",
            },
            generateImage: never,
            analyzeImages: never,
          };
        },
      },
    ],
  };
}
