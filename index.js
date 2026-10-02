const { program } = require('commander');
const { version } = require('./package.json');
const { showBanner, showStatusFooter } = require('./utils/helpers');
const { PLATFORM_CONFIG } = require('./utils/config');
const { autoDownload } = require('./utils/auto');

// Lazy-load the interactive module so simple CLI calls (--help / --version /
// single-platform commands) never pay for the full interactive chain.
let _input = null;
function getInput() {
  return (_input || (_input = require('./utils/input')));
}

// Accidental Ctrl+C guard for interactive sessions (a click in a QuickEdit
// console freezes output and users then hit Ctrl+C, killing the session).
// Armed by interactive entries only: first press prints a hint and opens a
// 3s window, second press exits (130). One-shot downloads keep instant exit.
let _exitArmed = false;
let _exitTimer = null;
function armExitGuard() {
  if (armExitGuard.done) return;
  armExitGuard.done = true;
  process.on('SIGINT', () => {
    if (_exitArmed) {
      clearTimeout(_exitTimer);
      _exitArmed = false;
      process.exit(130);
    }
    _exitArmed = true;
    process.stdout.write('\n[Ctrl+C] 再按一次确认退出（误触请忽略）。\n');
    _exitTimer = setTimeout(() => { _exitArmed = false; }, 3000);
    if (_exitTimer && typeof _exitTimer.unref === 'function') _exitTimer.unref();
  });
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
  .action(() => {
    armExitGuard();
    getInput().startInteractive();
  });

// Auto-detect command: `node index.js download <url>`
program
  .command('download <url>')
  .aliases(['dl', 'auto'])
  .description('Auto-detect platform from URL and download')
  .action(async (url) => {
    const downloadPath = program.opts().path || getInput().currentDownloadPath;
    await autoDownload(url, downloadPath);
  });

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
      const ok = await platform.handler(url, downloadPath);
      showStatusFooter();
      if (ok === false) process.exitCode = 1;
    });
});

// Extract custom download path from argv when we bypass program.parse()
// (the bare-URL fast path below). Supports `-p dir` and `--path=dir`.
function extractPathOption(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-p' || arg === '--path') {
      if (argv[i + 1] && !argv[i + 1].startsWith('-')) return argv[i + 1];
    } else if (arg.startsWith('--path=')) {
      return arg.slice('--path='.length);
    }
  }
  return program.opts().path || 'resultdownload_preniv';
}

// Auto-detect entry point: `node index.js <url>` — no platform prefix needed.
// Keep it ahead of program.parse() so a bare URL is treated as a download
// request rather than an unknown command.
const args = process.argv.slice(2);
const firstArg = args && args[0];
const isBareUrl =
  firstArg &&
  typeof firstArg === 'string' &&
  /^https?:\/\//i.test(firstArg);

if (isBareUrl) {
  (async () => {
    const downloadPath = extractPathOption(args.slice(1));
    const ok = await autoDownload(firstArg, downloadPath);
    if (ok === false) process.exitCode = 1;
  })();
} else if (process.argv.length === 2) {
  armExitGuard();
  getInput().startInteractive();
} else {
  program.parse();
}