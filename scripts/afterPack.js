// electron-builder afterPack hook.
//
// Why this exists: electron-builder copies extra files into the .app bundle
// after Electron's own (linker-signed, ad-hoc) signature has already been
// applied. That invalidates the bundle seal — `codesign` reports
// "code has no resources but signature indicates they must be present".
//
// On Apple Silicon, macOS refuses to run a binary whose signature is broken
// once the file carries the com.apple.quarantine attribute (i.e. anything
// downloaded from the internet), surfacing the misleading error:
//   "<App> is damaged and can't be opened. You should move it to the Trash."
//
// Re-sealing the bundle with a valid ad-hoc signature fixes that: the app is
// no longer "damaged", and downloaded copies open via right-click → Open
// (or after `xattr -dr com.apple.quarantine`).
//
// If a real Developer ID is configured (CSC_LINK / CSC_NAME), we skip this and
// let electron-builder perform proper signing + notarization instead.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterPack] ad-hoc re-signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
};
