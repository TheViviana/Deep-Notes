// electron-builder afterPack 钩子：没有开发者证书时对 .app 做 ad-hoc 签名。
// 完全无签名 + 下载隔离属性（com.apple.quarantine）会让 Gatekeeper 直接判
// 「"Deep Notes"已损坏，无法打开」；ad-hoc 签名后降级为「无法验证开发者」，
// 右键打开 / 系统设置放行即可，去掉隔离属性后可直接双击打开。
const { execSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  try {
    execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
    console.log(`  • ad-hoc signed ${path.basename(appPath)}`);
  } catch (err) {
    console.warn('  ⨠ ad-hoc 签名失败（不影响产物，仅影响首次打开的提示文案）:', String(err?.message || err).split('\n')[0]);
  }
};
