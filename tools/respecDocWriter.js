/**
 * Exports fetchAndWrite() method, allowing programmatic control of the
 * spec generator.
 *
 * For usage, see example a https://github.com/w3c/respec/pull/692
 */
/* jshint node: true, browser: false */
"use strict";
const os = require("os");
const puppeteer = require("puppeteer");
const colors = require("colors");
const { mkdtemp, readFile, writeFile } = require("fs").promises;
const path = require("path");
colors.setTheme({
  debug: "cyan",
  error: "red",
  warn: "yellow",
  info: "blue",
});

/**
 * Writes "data" to a particular outPath as UTF-8.
 * @private
 * @param  {String} outPath The relative or absolute path to write to.
 * @param  {String} data    The data to write.
 * @return {Promise}        Resolves when writing is done.
 */
async function writeTo(outPath, data) {
  let newFilePath = "";
  if (path.isAbsolute(outPath)) {
    newFilePath = outPath;
  } else {
    newFilePath = path.resolve(process.cwd(), outPath);
  }
  try {
    await writeFile(newFilePath, data, "utf-8");
  } catch (err) {
    console.error(err, err.stack);
    process.exit(1);
  }
}

/**
 * Fetches a ReSpec "src" URL, processes via NightmareJS and writes it to an
 * "out" path within a given "timeout".
 *
 * @public
 * @param  {String} src         A URL that is the ReSpec source.
 * @param  {String|null|""} out A path to write to. If null, goes to stdout.
 *                              If "", then don't write, just return value.
 * @param  {Object} whenToHalt  Object with two bool props (haltOnWarn,
 *                              haltOnError), allowing execution to stop
 *                              if either occurs.
 * @param  {Number} timeout     Optional. Milliseconds before NightmareJS
 *                              should timeout.
 * @return {Promise}            Resolves with HTML when done writing.
 *                              Rejects on errors.
 */
async function fetchAndWrite(
  src,
  out,
  whenToHalt,
  {
    timeout = 300000,
    disableSandbox = false,
    debug = false,
    useLocal = false,
  } = {}
) {
  const timer = createTimer(timeout);

  const userDataDir = await mkdtemp(`${os.tmpdir()}/respec2html-`);
  const args = disableSandbox ? ["--no-sandbox"] : undefined;
  const browser = await puppeteer.launch({
    userDataDir,
    args,
    devtools: debug,
  });

  try {
    const page = await browser.newPage();
    if (useLocal) {
      await useLocalReSpec(page);
    }
    const handleConsoleMessages = makeConsoleMsgHandler(page);
    const haltFlags = {
      error: false,
      warn: false,
    };
    handleConsoleMessages(haltFlags);
    const url = new URL(src);
    const response = await page.goto(url, { timeout });
    if (
      !response.ok() &&
      response.status() /* workaround: 0 means ok for local files */
    ) {
      const warn = colors.warn(`📡 HTTP Error ${response.status()}:`);
      // don't show params, as they can contain the API key!
      const debugURL = `${url.origin}${url.pathname}`;
      const msg = `${warn} ${colors.debug(debugURL)}`;
      throw new Error(msg);
    }
    await checkIfReSpec(page);
    const html = await generateHTML(page, url, timer);
    const abortOnWarning = whenToHalt.haltOnWarn && haltFlags.warn;
    const abortOnError = whenToHalt.haltOnError && haltFlags.error;
    if (abortOnError || abortOnWarning) {
      process.exit(1);
    }
    switch (out) {
      case null:
        process.stdout.write(html);
        break;
      case "":
        break;
      default:
        await writeTo(out, html);
    }
    // Race condition: Wait before page close for all console messages to be logged
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.close();
    return html;
  } finally {
    await browser.close();
  }
}

/**
 * Replace the ReSpec script in document with the locally installed one. This is
 * useful in CI env or when you want to pin the ReSpec version.
 *
 * @assumption The ReSpec script being used in the document is hosted on either
 * w3.org or w3c.github.io. If this assumption doesn't hold true (interception
 * fails), this function will timeout.
 *
 * The following ReSpec URLs are supported:
 * https://www.w3.org/Tools/respec/${profile}
 * https://w3c.github.io/respec/builds/${profile}.js
 * file:///home/path-to-respec/builds/${profile}.js
 * http://localhost:PORT/builds/${profile}.js
 * https://example.com/builds/${profile}.js
 *
 * @param {import("puppeteer").Page} page
 */
async function useLocalReSpec(page) {
  await page.setRequestInterception(true);

  /** @param {import("puppeteer").Request} req */
  const isRespecScript = req => {
    if (req.method() !== "GET" || req.resourceType() !== "script") {
      return false;
    }

    const { host, pathname } = new URL(req.url());
    switch (host) {
      case "www.w3.org":
        return (
          pathname.startsWith("/Tools/respec/") &&
          !pathname.includes("respec-highlight")
        );
      case "w3c.github.io":
        return pathname.startsWith("/respec/builds/");
      default:
        // localhost, file://, and everything else
        return /\/builds\/respec-[\w-]+\.js$/.test(pathname);
    }
  };

  page.on("request", async function requestInterceptor(request) {
    if (!isRespecScript(request)) {
      await request.continue();
      return;
    }

    const url = new URL(request.url());
    const respecProfileRegex = /\/(respec-[\w-]+)(?:\.js)?$/;
    const profile = url.pathname.match(respecProfileRegex)[1];
    const localPath = path.join(__dirname, "..", "builds", `${profile}.js`);
    console.log(colors.info(`Intercepted ${url} to respond with ${localPath}`));
    await request.respond({
      contentType: "text/javascript; charset=utf-8",
      body: await readFile(localPath),
    });
    // Workaround for https://github.com/puppeteer/puppeteer/issues/4208
    page.removeListener("request", requestInterceptor);
    await page.setRequestInterception(false);
  });
}

/**
 * @param {import("puppeteer").Page} page
 * @param {string} url
 * @param {ReturnType<typeof createTimer>} timer
 */
async function generateHTML(page, url, timer) {
  await page.waitForFunction(() => window.hasOwnProperty("respecVersion"));
  const version = await page.evaluate(getVersion);
  try {
    return await page.evaluate(evaluateHTML, version, timer);
  } catch (err) {
    const msg = `\n😭  Sorry, there was an error generating the HTML. Please report this issue!\n${colors.debug(
      `${
        `Specification: ${url}\n` +
        `ReSpec version: ${version.join(".")}\n` +
        "File a bug: https://github.com/w3c/respec/\n"
      }${err ? `Error: ${err.stack}\n` : ""}`
    )}`;
    throw new Error(msg);
  }
}

/**
 * @param {import("puppeteer").Page} page
 */
async function checkIfReSpec(page) {
  const isRespecDoc = await page.evaluate(isRespec);
  if (!isRespecDoc) {
    const msg = `${colors.warn(
      "🕵️‍♀️  That doesn't seem to be a ReSpec document. Please check manually:"
    )} ${colors.debug(page.url)}`;
    throw new Error(msg);
  }
  return isRespecDoc;
}

async function isRespec() {
  const query = "script[data-main*='profile-'], script[src*='respec']";
  if (document.head.querySelector(query)) {
    return true;
  }
  await new Promise(resolve => {
    document.onreadystatechange = () => {
      if (document.readyState === "complete") {
        resolve();
      }
    };
    document.onreadystatechange();
  });
  await new Promise(resolve => {
    setTimeout(resolve, 2000);
  });
  return Boolean(document.getElementById("respec-ui"));
}

/**
 * @param {number[]} version
 * @param {ReturnType<typeof createTimer>} timer
 */
async function evaluateHTML(version, timer) {
  await timeout(document.respecIsReady, timer.remaining);

  const [major, minor] = version;
  if (major < 20 || (major === 20 && minor < 10)) {
    console.warn(
      "👴🏽  Ye Olde ReSpec version detected! Please update to 20.10.0 or above. " +
        `Your version: ${window.respecVersion}.`
    );
    // Document references an older version of ReSpec that does not yet
    // have the "core/exporter" module. Try with the old "ui/save-html"
    // module.
    const { exportDocument } = await new Promise((resolve, reject) => {
      require(["ui/save-html"], resolve, err => {
        reject(new Error(err.message));
      });
    });
    return exportDocument("html", "text/html");
  } else {
    const { rsDocToDataURL } = await new Promise((resolve, reject) => {
      require(["core/exporter"], resolve, err => {
        reject(new Error(err.message));
      });
    });
    const dataURL = rsDocToDataURL("text/html");
    const encodedString = dataURL.replace(/^data:\w+\/\w+;charset=utf-8,/, "");
    return decodeURIComponent(encodedString);
  }

  function timeout(promise, ms) {
    return new Promise((resolve, reject) => {
      promise.then(resolve, reject);
      const msg = `Timeout: document.respecIsReady didn't resolve in ${ms}ms.`;
      setTimeout(() => reject(msg), ms);
    });
  }
}

function getVersion() {
  if (window.respecVersion === "Developer Edition") {
    return [123456789, 0, 0];
  }
  return window.respecVersion.split(".").map(str => parseInt(str, 10));
}
/**
 * Handles messages from the browser's Console API.
 *
 * @param  {import("puppeteer").Page} page Instance of page to listen on.
 * @return {Function}
 */
function makeConsoleMsgHandler(page) {
  /**
   * Specifies what to do when the browser emits "error" and "warn" console
   * messages.
   *
   * @param  {Object} whenToHalt Object with two bool props (haltOnWarn,
   *                             haltOnError), allowing execution to stop
   *                             if either occurs.
   * @return {Void}
   */
  return function handleConsoleMessages(haltFlags) {
    page.on("console", async message => {
      const args = await Promise.all(message.args().map(stringifyJSHandle));
      const msgText = message.text();
      const text = args.filter(msg => msg !== "undefined").join(" ");
      const type = message.type();
      if (
        (type === "error" || type === "warning") &&
        msgText && // browser errors have text
        !message.args().length // browser errors/warnings have no arguments
      ) {
        // Since Puppeteer 1.4 reports _all_ errors, including CORS
        // violations and slow preloads. Unfortunately, there is no way to distinguish
        // these errors from other errors, so using this ugly hack.
        // https://github.com/GoogleChrome/puppeteer/issues/1939
        return;
      }
      const output = `ReSpec ${type}: ${colors.debug(text)}`;
      switch (type) {
        case "error":
          console.error(colors.error(`😱 ${output}`));
          haltFlags.error = true;
          break;
        case "warning":
          // Ignore polling of respecDone
          if (/document\.respecDone/.test(text)) {
            return;
          }
          console.warn(colors.warn(`🚨 ${output}`));
          haltFlags.warn = true;
          break;
      }
    });
  };
}

async function stringifyJSHandle(handle) {
  return await handle.executionContext().evaluate(o => String(o), handle);
}

function createTimer(duration) {
  const start = Date.now();
  return {
    get remaining() {
      const spent = Date.now() - start;
      return Math.max(0, duration - spent);
    },
  };
}

exports.fetchAndWrite = fetchAndWrite;
