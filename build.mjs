import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDirectory = new URL("./public/", import.meta.url);

await mkdir(publicDirectory, { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["client.js"],
  bundle: true,
  minify: true,
  platform: "browser",
  inject: [fileURLToPath(new URL("./browser-globals.js", import.meta.url))],
  target: "es2022",
  outfile: "public/app.js",
  logLevel: "info",
});

await Promise.all(["index.html", "styles.css", "crown.svg"].map((name) =>
  copyFile(new URL(name, import.meta.url), new URL(name, publicDirectory))
));
await mkdir(new URL("graphics/", publicDirectory), { recursive: true });
await Promise.all(["coin-medallion.jpeg", "juicy-banner.jpeg"].map((name) =>
  copyFile(new URL(name, import.meta.url), new URL(`graphics/${name}`, publicDirectory))
));
