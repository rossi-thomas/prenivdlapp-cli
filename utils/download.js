const axios = require('axios');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const { checkFileSize, MAX_FILE_SIZE } = require('./functions');

function getFileExtension(url, defaultExt = 'mp4') {
  try {
    const tokenMatch = url.match(/token=([^&]+)/);
    if (tokenMatch && tokenMatch[1]) {
      const token = tokenMatch[1];
      const parts = token.split('.');
      if (parts.length >= 2) {
        const payload = parts[1];
        const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
        if (decoded.filename && typeof decoded.filename === 'string') {
          const dotIndex = decoded.filename.lastIndexOf('.');
          // Only accept a real extension (e.g. "video.mp4"), never a bare
          // filename ("video") or leading/trailing dot (".mp4", "video.").
          if (dotIndex > 0 && dotIndex < decoded.filename.length - 1) {
            return decoded.filename.slice(dotIndex + 1).toLowerCase() || defaultExt;
          }
        }
      }
    }
  } catch (error) {
  }
  // Fall back to the extension in the URL path (e.g. Instagram video CDN
  // URLs carry ".mp4"). Only accept a known media extension so query strings
  // and bare filenames never leak through.
  try {
    const { pathname } = new URL(url);
    const lastSegment = pathname.split('/').pop() || '';
    const dotIndex = lastSegment.lastIndexOf('.');
    if (dotIndex > 0 && dotIndex < lastSegment.length - 1) {
      const ext = lastSegment.slice(dotIndex + 1).toLowerCase();
      if (/^(mp4|m4a|m4v|mp3|webm|webp|jpg|jpeg|png|gif|mov|avi|wav|opus|ogg|mkv|heic)$/.test(ext)) {
        return ext;
      }
    }
  } catch (error) {
  }
  return defaultExt;
}

async function downloadFile(url, filename, spinner, basePath = 'resultdownload_preniv', maxSize = null) {
  try {
    if (maxSize) {
      const sizeInfo = await checkFileSize(url);
      if (sizeInfo && sizeInfo.exceedsLimit) {
        spinner.fail(chalk.red(`File size (${sizeInfo.sizeInMB} MB) exceeds maximum limit of ${maxSize / (1024 * 1024)} MB`));
        console.log(chalk.gray('   • This file is too large to download'));
        return null;
      }
      if (sizeInfo) {
        spinner.text = ` Downloading (${sizeInfo.sizeInMB} MB)...`;
      }
    }

    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true });
    }
    const fullPath = path.join(basePath, filename);
    
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream'
    });

    const writer = fs.createWriteStream(fullPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        spinner.succeed(chalk.green(`Downloaded: ${fullPath}`));
        resolve(fullPath);
      });
      writer.on('error', reject);
    });
  } catch (error) {
    spinner.fail(chalk.red(`Failed to download`));
    throw error;
  }
}

module.exports = { downloadFile, checkFileSize, getFileExtension, MAX_FILE_SIZE };
