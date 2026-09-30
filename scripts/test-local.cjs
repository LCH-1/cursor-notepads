const fs = require('fs');
const path = require('path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const root = path.resolve(__dirname, '..');
  const testRoot = path.join(root, '.vscode-test', 'notepads-local');
  const workspace = path.join(testRoot, 'workspace');
  const userData = path.join(testRoot, 'user-data');
  const resultFile = path.join(testRoot, 'result.json');
  const runnerFile = path.join(testRoot, 'runner.cjs');
  const runner = path.join(root, 'node_modules', '@vscode', 'test-cli', 'out', 'runner.cjs');
  const testDirectory = path.join(root, 'out', 'test');
  const testFiles = fs.readdirSync(testDirectory, { recursive: true }).filter(file => file.endsWith('.test.js')).map(file => path.join(testDirectory, file));
  const themeFiles = Array.from({ length: 16 }, (_, slot) => path.join(root, 'themes', `notepads-${slot}.json`));
  const originalThemes = themeFiles.map(file => fs.readFileSync(file));
  fs.mkdirSync(workspace, { recursive: true });
  fs.rmSync(resultFile, { force: true });
  fs.writeFileSync(runnerFile, `
const fs = require('fs');
exports.run = async () => {
  try {
    await require(${JSON.stringify(runner)}).run();
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ passed: true }));
  } catch (error) {
    fs.writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ passed: false, error: String(error) }));
    throw error;
  }
};
`);
  const log = fs.createWriteStream(path.join(testRoot, 'run.log'));
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = chunk => log.write(chunk);
  process.stderr.write = chunk => log.write(chunk);
  let failure;
  try {
    await runTests({
      vscodeExecutablePath: process.env.CNP_TEST_EXECUTABLE || path.join(process.env.LOCALAPPDATA, 'Programs', 'cursor', 'Cursor.exe'),
      extensionDevelopmentPath: process.env.CNP_TEST_THEME_EXTENSION ? [root, process.env.CNP_TEST_THEME_EXTENSION] : root,
      extensionTestsPath: runnerFile,
      launchArgs: [workspace, `--user-data-dir=${userData}`, `--extensions-dir=${path.join(testRoot, 'extensions')}`, '--disable-gpu'],
      extensionTestsEnv: {
        ELECTRON_RUN_AS_NODE: undefined,
        CNP_TEST_GLOBAL_STORAGE_DIR: path.join(userData, 'User', 'globalStorage', 'lch.cursor-notepads'),
        VSCODE_TEST_OPTIONS: JSON.stringify({ mochaOpts: { timeout: 20000 }, files: testFiles, preload: [], colorDefault: false }),
      },
    });
  } catch (error) {
    failure = error;
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
    await new Promise(resolve => log.end(resolve));
    themeFiles.forEach((file, index) => fs.writeFileSync(file, originalThemes[index]));
  }
  if (failure) throw failure;
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
