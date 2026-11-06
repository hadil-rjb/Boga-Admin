import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { Browser } from "puppeteer-core";

/**
 * Headless Chromium for server-side slide renders.
 *
 * puppeteer-core drives the browser; the binary comes from, in order:
 *   - CHROME_PATH (a local Chrome / Chromium, e.g. for development on macOS),
 *   - @sparticuz/chromium on Linux (a self-contained Chromium build: no apt packages needed, works on
 *     Render's native Node runtime; it is unpacked to /tmp on first launch),
 *   - the usual Google Chrome locations.
 * Both packages are ES modules, loaded with a real import() from this CommonJS build.
 *
 * On Linux, outside AWS Lambda (Render), two things the Lambda image provides are set up here:
 *   - NSS libraries: @sparticuz/chromium ships them for Amazon Linux; they're used when the system has none;
 *   - fallback fonts: the slides embed their own web fonts, but characters those fonts don't have
 *     (★ impact stars, arrows, symbols) need a system font, and the bundled Chromium only has Open Sans.
 *     DejaVu Sans (dejavu-fonts-ttf) is added, after the system fonts, so they never render as empty boxes.
 */
const nativeImport = new Function("s", "return import(s)") as <T = any>(s: string) => Promise<T>;
/** Inside vitest's vm context the Function-wrapped import has no callback; its own transformed import() works there (as footage/shared.ts) */
const esm = async <T = any>(s: string): Promise<T> => {
  try { return await nativeImport<T>(s); } catch (e: any) {
    if (!/dynamic import callback/i.test(String(e?.message))) throw e;
    return import(/* @vite-ignore */ s);
  }
};

const LOCAL = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

const NSS = ["/usr/lib/x86_64-linux-gnu/libnss3.so", "/lib/x86_64-linux-gnu/libnss3.so", "/usr/lib64/libnss3.so", "/usr/lib/libnss3.so", "/usr/lib/aarch64-linux-gnu/libnss3.so"];

async function linuxSetup(chromium: any) {
  const bin = join(dirname(require.resolve("@sparticuz/chromium")), "..", "bin");
  if (!NSS.some((p) => existsSync(p)) && existsSync(join(bin, "al2023.tar.br"))) {
    const lib = join(await chromium.inflate(join(bin, "al2023.tar.br")), "lib");
    if (!(process.env.LD_LIBRARY_PATH || "").split(":").includes(lib)) process.env.LD_LIBRARY_PATH = [lib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  }
  if (!process.env.FONTCONFIG_PATH) {
    const dir = join(tmpdir(), "boga-fonts"), ttf = join(dirname(require.resolve("dejavu-fonts-ttf/package.json")), "ttf");
    mkdirSync(join(dir, "fonts"), { recursive: true });
    for (const f of ["DejaVuSans.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans-Oblique.ttf", "DejaVuSans-BoldOblique.ttf"]) copyFileSync(join(ttf, f), join(dir, "fonts", f));
    writeFileSync(join(dir, "fonts.conf"), `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir>/usr/share/fonts</dir>
  <dir>/usr/local/share/fonts</dir>
  <dir>${join(tmpdir(), "fonts")}</dir>
  <dir>${join(dir, "fonts")}</dir>
  <cachedir>${join(tmpdir(), "fonts-cache")}</cachedir>
  <alias><family>sans-serif</family><prefer><family>DejaVu Sans</family></prefer></alias>
</fontconfig>
`);
    process.env.FONTCONFIG_PATH = dir;
  }
}

/** extraArgs: added to the launch flags (the footage parity test asks for SwiftShader WebGL) */
export async function launchChromium(extraArgs: string[] = []): Promise<Browser> {
  const puppeteer = (await esm("puppeteer-core")).default;
  const common = ["--hide-scrollbars", "--mute-audio", "--font-render-hinting=none", "--disable-dev-shm-usage", ...extraArgs];
  const custom = process.env.CHROME_PATH;
  if (!custom && process.platform === "linux") {
    const mod = await esm("@sparticuz/chromium"), chromium = mod.default;
    const executablePath = await chromium.executablePath();
    await linuxSetup({ inflate: mod.inflate });
    return puppeteer.launch({
      executablePath,
      args: [...chromium.args, ...common],
      headless: "shell",
      defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
    });
  }
  const executablePath = custom || LOCAL.find((p) => existsSync(p));
  if (!executablePath) throw new Error("No Chrome found for server rendering: set CHROME_PATH");
  return puppeteer.launch({
    executablePath,
    args: ["--no-sandbox", ...common],
    headless: true,
    defaultViewport: { width: 1280, height: 900, deviceScaleFactor: 1 },
  });
}
