/**
 * A synthetic Assetgrove extension with one provider adapter, `keyed:paint`: it declares a fixed
 * host and the key variable it reads, and its provider is never called.
 */
export default function extension() {
  return {
    api: 2,
    name: "keyed",
    adapters: [
      {
        id: "keyed:paint",
        capabilities: ["image"],
        fixedHosts: ["api.keyed.example"],
        endpointFromSettings: false,
        defaultKeyEnv: "KEYED_API_KEY",
        defaultRoutes: {
          still: {
            model: "paint-1",
            estimatedCostUsd: 0.01,
            providerTerms: "keyed terms",
            outputGrant: { license: "MIT", plan: "fixture", commercial: true, relabel: true },
          },
        },
        create(c) {
          const never = async () => {
            throw new Error("keyed:paint is never called");
          };
          return {
            billing: {
              adapter: "keyed:paint",
              providerId: c.providerId,
              paid: true,
              hosts: ["api.keyed.example"],
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
