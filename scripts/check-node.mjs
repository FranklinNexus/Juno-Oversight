const [major, minor, patch] = process.version
  .slice(1)
  .split(".")
  .map((part) => Number(part));

const ok =
  major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0)));

if (!ok) {
  console.error(
    `[juno] Node ${process.version} is too old for @cursor/sdk (need >= 22.13).`,
  );
  console.error("[juno] Run: nvm install 22.13.1 && nvm use 22.13.1");
  process.exit(1);
}

console.log(`[juno] Node ${process.version} OK`);
