const chalk = require('chalk');
const ora = require('ora');
const inquirer = require('inquirer');
const { getApi } = require('./api');
const { downloadFile } = require('../utils/download');
const { fetchJson, handleError, generateFilename, getSelectedOption, buildDownloadChoices } = require('../utils/functions');

// The API nests the payload under `data.data` while some earlier responses
// expose `media` at the top level. Resolve whichever shape is present.
function resolveTwitterPayload(data) {
  return data && data.data && Array.isArray(data.data.media) ? data.data : data;
}

async function downloadTwitter(url, basePath = 'resultdownload_preniv') {
  const spinner = ora(' Fetching Twitter video data...').start();

  try {
    const data = await fetchJson(`${getApi.twitter}${encodeURIComponent(url)}`, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 10; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.210 Mobile Safari/537.36'
      }
    });

    if (!data || !data.status) {
      spinner.fail(chalk.red(' Failed to fetch Twitter video data'));
      console.log(chalk.gray('   • The API returned an error or invalid response'));
      return false;
    }

    // The API nests the payload under `data.data`; some earlier responses
    // expose `media` at the top level. Resolve whichever shape is present.
    const payload = resolveTwitterPayload(data);

    if (!payload.media || payload.media.length === 0) {
      spinner.fail(chalk.red(' Invalid video data received'));
      console.log(chalk.gray('   • The video may be private or unavailable'));
      return false;
    }

    spinner.succeed(chalk.green(' Twitter video data fetched successfully!'));
    console.log('');
    console.log(chalk.cyan(' Video Information:'));
    console.log(chalk.gray('   • ') + chalk.white(`Type: ${payload.type || 'video'}`));
    console.log(chalk.gray('   • ') + chalk.white(`Found ${payload.media.length} quality option(s)`));
    console.log('');

    if (payload.media.length === 1) {
      const downloadSpinner = ora(' Downloading video...').start();
      const options = getSelectedOption('twitter', { url: payload.media[0].url, quality: payload.media[0].quality });
      const filename = generateFilename('twitter', {
        quality: payload.media[0].quality
      });
      await downloadFile(options.url, filename, downloadSpinner, basePath);
      return true;
    } else {
      const downloadChoices = buildDownloadChoices('twitter', { media: payload.media });
      
      downloadChoices.push({
        name: chalk.gray(' Cancel'),
        value: 'cancel'
      });
      
      const { selectedDownload } = await inquirer.prompt([
        {
          type: 'list',
          name: 'selectedDownload',
          message: 'Select download option:',
          choices: downloadChoices
        }
      ]);
      
      if (selectedDownload === 'cancel') {
        console.log(chalk.yellow('\n Download cancelled.'));
        return false;
      }
      
      const downloadSpinner = ora(` Downloading ${selectedDownload.quality}p video...`).start();
      const options = getSelectedOption('twitter', selectedDownload);
      const filename = generateFilename('twitter', {
        quality: selectedDownload.quality
      });
      await downloadFile(options.url, filename, downloadSpinner, basePath);
      return true;
    }
  } catch (error) {
    handleError(error, spinner);
    return false;
  }
}

module.exports = { downloadTwitter, resolveTwitterPayload };
