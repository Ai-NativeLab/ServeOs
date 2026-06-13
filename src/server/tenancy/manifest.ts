export type ManifestInput = { name: string; primaryColor: string; slug: string };

export type WebManifest = {
  name: string;
  short_name: string;
  start_url: string;
  display: "standalone";
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string }[];
};

export function buildManifest(input: ManifestInput): WebManifest {
  return {
    name: input.name,
    short_name: input.name.slice(0, 12),
    start_url: "/",
    display: "standalone",
    background_color: "#FFFFFF",
    theme_color: input.primaryColor,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
