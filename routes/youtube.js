const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { getApi, normalizer } = require('./api');
const { downloadFile, MAX_FILE_SIZE } = require('../utils/download');
const { fetchJson, handleError, generateFilename, getSelectedOption, buildDownloadChoices } = require('../utils/functions');

function mergeAudioVideo(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-i', videoPath, '-i', audioPath, '-c', 'copy', outputPath], {
      windowsHide: true
    }, (error, _stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || error.message).slice(-500)));
      resolve(outputPath);
    });
  });
}

async function downloadYoutube(url, basePath = 'resultdownload_preniv') {
  const spinner = ora(' Fetching YouTube video data...').start();
  
  try {
    const rawData = await fetchJson(`${getApi.youtube}${encodeURIComponent(url)}`, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.210 Mobile Safari/537.36'
      }
    });

    if (!rawData || !rawData.status) {
      spinner.fail(chalk.red(' Failed to fetch YouTube video data'));
      console.log(chalk.gray('   • The API returned an error or invalid response'));
      return false;
    }

    const data = normalizer.normalizeYouTube(rawData.data, 'primary');

    if (!data.downloads.video.length && !data.downloads.audio.length) {
      spinner.fail(chalk.red(' No download formats available'));
      console.log(chalk.gray('   • The video is unavailable, restricted, or protected by YouTube'));
      console.log(chalk.gray('   • New/small-channel videos often require sign-in verification (PO token)'));
      return false;
    }

    spinner.succeed(chalk.green(' YouTube video data fetched successfully!'));
    console.log('');
    console.log(chalk.cyan(' Video Information:'));
    console.log(chalk.gray('   • ') + chalk.white(`Title: ${data.title || 'No title'}`));
    if (data.duration) {
      console.log(chalk.gray('   • ') + chalk.white(`Duration: ${Math.floor(data.duration / 60)}:${String(data.duration % 60).padStart(2, '0')}`));
    }
    console.log('');

    const videoWithAudio = data.downloads.video.filter(f => f.type === 'video_with_audio');
    const videoOnly = data.downloads.video.filter(f => f.type === 'video');
    const audioOnly = data.downloads.audio;

    // Desktop's one-URL BAT uses this mode so it does not depend on inquirer's
    // terminal UI. Prefer the highest progressive video (it already contains
    // audio); fall back to the best audio-only format if necessary.
    const autoBest = process.env.PRENIV_AUTO_BEST === '1';
    let selectedDownload;
    if (autoBest) {
      // MP4 + M4A can be remuxed without re-encoding. Prefer it over a higher
      // WebM video-only stream so the resulting file works everywhere.
      selectedDownload = videoWithAudio[0] || videoOnly.find(f => f.format === 'mp4') || videoOnly[0] || audioOnly[0];
      console.log(chalk.gray(`   • Auto-selected: ${selectedDownload.quality}`));
    } else {
      const downloadChoices = buildDownloadChoices('youtube', { videoWithAudio, videoOnly, audioOnly });
      downloadChoices.push({
        name: chalk.gray(' Cancel'),
        value: 'cancel'
      });

      ({ selectedDownload } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedDownload',
          message: 'Select download option:',
          choices: downloadChoices,
          pageSize: 15
        }
      ]));
    }

    if (selectedDownload === 'cancel') {
      console.log(chalk.yellow('\n Download cancelled.'));
      return false;
    }

    if (autoBest && selectedDownload.type === 'video' && audioOnly.length > 0) {
      const audio = audioOnly[0];
      const finalFilename = generateFilename('youtube', {
        title: data.title,
        quality: selectedDownload.quality,
        ext: selectedDownload.format
      });
      const finalExt = path.extname(finalFilename) || '.mp4';
      const stem = finalFilename.slice(0, -finalExt.length);
      const videoTemp = `${stem}.video.part${finalExt}`;
      const audioExt = `.${audio.format || 'm4a'}`;
      const audioTemp = `${stem}.audio.part${audioExt}`;
      const videoOptions = getSelectedOption('youtube', selectedDownload);
      const audioOptions = getSelectedOption('youtube', audio);

      const videoSpinner = ora(` Downloading ${selectedDownload.quality} video...`).start();
      const savedVideo = await downloadFile(videoOptions.url, videoTemp, videoSpinner, basePath);
      if (!savedVideo) return false;

      const audioSpinner = ora(' Downloading audio...').start();
      const savedAudio = await downloadFile(audioOptions.url, audioTemp, audioSpinner, basePath);
      if (!savedAudio) return false;

      const mergeSpinner = ora(' Merging video and audio...').start();
      try {
        const output = path.join(basePath, finalFilename);
        await mergeAudioVideo(savedVideo, savedAudio, output);
        fs.rmSync(savedVideo, { force: true });
        fs.rmSync(savedAudio, { force: true });
        mergeSpinner.succeed(chalk.green(`Downloaded: ${output}`));
        return true;
      } catch (mergeError) {
        mergeSpinner.fail(chalk.red('Failed to merge video and audio'));
        console.log(chalk.gray('   • Install ffmpeg and ensure it is available on PATH'));
        return false;
      }
    }

    const downloadSpinner = ora(` Downloading ${selectedDownload.type}...`).start();
    const options = getSelectedOption('youtube', selectedDownload);
    const filename = generateFilename('youtube', {
      title: data.title,
      quality: selectedDownload.quality,
      ext: selectedDownload.format
    });
    // YouTube direct files are commonly hundreds of MB. Do not impose the
    // legacy 35 MB API-proxy limit on a local direct download.
    const saved = await downloadFile(options.url, filename, downloadSpinner, basePath);
    return Boolean(saved);

  } catch (error) {
    handleError(error, spinner);
    return false;
  }
}

module.exports = { downloadYouTube: downloadYoutube };
