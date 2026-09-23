/**
 * Auto-detect & download from any supported social media URL.
 *
 * Lets the CLI work without a platform prefix:
 *   node index.js https://www.tiktok.com/@user/video/1234567890
 *
 * Pipeline:
 *   1. Match the URL's hostname against the platform registry.
 *   2. If unmatched, follow redirects (short links like v.douyin.com,
 *      pin.it, xhslink.com...) once and retry matching on the final URL.
 *   3. Dispatch to the matched platform's lazy handler.
 */

const chalk = require('chalk');
const { showBanner, showProcessing, showStatusFooter } = require('./helpers');
const { PLATFORM_CONFIG, matchPlatform } = require('./config');

/** Parse & lowercase hostname; throws on invalid URL. */
function getHostname(url) {
  return new URL(url).hostname.toLowerCase();
}

/**
 * Follow redirects to the final URL.
 * Returns the original URL on any failure so callers can still report
 * "unsupported platform" gracefully instead of crashing.
 */
async function resolveRedirect(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal
    });
    return res.url || url;
  } catch (_) {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolve a URL to { platform, url } or null when unsupported. */
async function detectPlatform(url) {
  const hostname = getHostname(url);
  const platform = matchPlatform(hostname, url);
  if (platform) {
    return { platform, url };
  }

  // Short-link share URLs usually 30x to the canonical page — resolve once,
  // then re-match. Requires Node 20+ (native fetch with redirect follow).
  const resolvedUrl = await resolveRedirect(url);
  if (resolvedUrl !== url) {
    const resolvedHost = getHostname(resolvedUrl);
    const resolvedPlatform = matchPlatform(resolvedHost, resolvedUrl);
    if (resolvedPlatform) {
      return { platform: resolvedPlatform, url: resolvedUrl };
    }
  }
  return null;
}

/** Auto-detect the platform and run its download handler. */
async function autoDownload(url, downloadPath) {
  showBanner();

  let detected = null;
  try {
    detected = await detectPlatform(url);
  } catch (_) {
    detected = null;
  }

  if (!detected) {
    const supportedPlatforms = PLATFORM_CONFIG.map((p) => p.name).join(', ');
    console.log('');
    console.log(chalk.red(' • Unsupported platform or invalid URL.'));
    console.log(chalk.gray(` • Supported platforms: ${supportedPlatforms}`));
    showStatusFooter();
    return false;
  }

  const { platform, url: targetUrl } = detected;
  showProcessing('Fetching', ` Analyzing ${platform.name} ${platform.mediaType}...`);
  await platform.handler(targetUrl, downloadPath);
  showStatusFooter();
  return true;
}

module.exports = { autoDownload, detectPlatform, resolveRedirect, getHostname };