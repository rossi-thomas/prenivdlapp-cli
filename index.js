const { program } = require('commander');
const { version } = require('./package.json');
const { showBanner, showStatusFooter } = require('./utils/helpers');
const { PLATFORM_CONFIG } = require('./utils/config');

// Lazy-load the interactive module so simple CLI calls (--help / --version /
// single-platform commands) never pay for the full interactive chain.
let _input = null;
function getInput() {
  return (_input || (_input = require('./utils/input')));
}

program
  .name('prnvapp')
  .description('Social Media Downloader CLI')
  .version(version)
  .option('-p, --path <directory>', 'Custom download directory (default: "resultdownload_preniv")', 'resultdownload_preniv');

program
  .command('interactive')
  .alias('i')
  .description('Start interactive mode')
  .action(() => getInput().startInteractive());

PLATFORM_CONFIG.forEach(platform => {
  const cmd = program.command(`${platform.command} <url>`);

  if (platform.alias) {
    cmd.alias(platform.alias);
  }

  cmd
    .description(`Download from ${platform.name}`)
    .action(async (url) => {
      showBanner();
      const downloadPath = program.opts().path || getInput().currentDownloadPath;
      await platform.handler(url, downloadPath);
      showStatusFooter();
    });
});

if (process.argv.length === 2) {
  getInput().startInteractive();
} else {
  program.parse();
}