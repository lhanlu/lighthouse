/**
 * @license Copyright 2016 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const log = require('lighthouse-logger');
const manifestParser = require('../lib/manifest-parser.js');
const stacksGatherer = require('../lib/stack-collector.js');
const LHError = require('../lib/lh-error.js');
const URL = require('../lib/url-shim.js');
const NetworkRecorder = require('../lib/network-recorder.js');
const constants = require('../config/constants.js');

const Driver = require('../gather/driver.js'); // eslint-disable-line no-unused-vars

/** @typedef {import('./gatherers/gatherer.js').PhaseResult} PhaseResult */
/**
 * Each entry in each gatherer result array is the output of a gatherer phase:
 * `beforePass`, `pass`, and `afterPass`. Flattened into an `LH.Artifacts` in
 * `collectArtifacts`.
 * @typedef {Record<keyof LH.GathererArtifacts, Array<PhaseResult|Promise<PhaseResult>>>} GathererResults
 */
/** @typedef {Array<[keyof GathererResults, GathererResults[keyof GathererResults]]>} GathererResultsEntries */
/**
 * Class that drives browser to load the page and runs gatherer lifecycle hooks.
 * Execution sequence when GatherRunner.run() is called:
 *
 * 1. Setup
 *   A. driver.connect()
 *   B. GatherRunner.setupDriver()
 *     i. assertNoSameOriginServiceWorkerClients
 *     ii. retrieve and save userAgent
 *     iii. beginEmulation
 *     iv. enableRuntimeEvents/enableAsyncStacks
 *     v. evaluateScriptOnLoad rescue native Promise from potential polyfill
 *     vi. register a performance observer
 *     vii. register dialog dismisser
 *     viii. clearDataForOrigin
 *
 * 2. For each pass in the config:
 *   A. GatherRunner.beforePass()
 *     i. navigate to about:blank
 *     ii. Enable network request blocking for specified patterns
 *     iii. all gatherers' beforePass()
 *   B. GatherRunner.pass()
 *     i. cleanBrowserCaches() (if it's a perf run)
 *     ii. beginDevtoolsLog()
 *     iii. beginTrace (if requested)
 *     iv. GatherRunner.loadPage()
 *       a. navigate to options.url (and wait for onload)
 *     v. all gatherers' pass()
 *   C. GatherRunner.afterPass()
 *     i. endTrace (if requested) & endDevtoolsLog & endThrottling
 *     ii. all gatherers' afterPass()
 *
 * 3. Teardown
 *   A. clearDataForOrigin
 *   B. GatherRunner.disposeDriver()
 *   C. collect all artifacts and return them
 *     i. collectArtifacts() from completed passes on each gatherer
 *     ii. add trace and devtoolsLog data
 */
class GatherRunner {
  /**
   * Loads about:blank and waits there briefly. Since a Page.reload command does
   * not let a service worker take over, we navigate away and then come back to
   * reload. We do not `waitForLoad` on about:blank since a page load event is
   * never fired on it.
   * @param {Driver} driver
   * @param {string=} url
   * @return {Promise<void>}
   */
  static async loadBlank(driver, url = constants.defaultPassConfig.blankPage) {
    const status = {msg: 'Resetting state with about:blank', id: 'lh:gather:loadBlank'};
    log.time(status);
    await driver.gotoURL(url, {waitForNavigated: true});
    log.timeEnd(status);
  }

  /**
   * Loads options.url with specified options. If the main document URL
   * redirects, options.url will be updated accordingly. As such, options.url
   * will always represent the post-redirected URL. options.requestedUrl is the
   * pre-redirect starting URL.
   * @param {Driver} driver
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<void>}
   */
  static async loadPage(driver, passContext) {
    const gatherers = passContext.passConfig.gatherers;
    const status = {
      msg: 'Loading page & waiting for onload',
      id: `lh:gather:loadPage-${passContext.passConfig.passName}`,
      args: [gatherers.map(g => g.instance.name).join(', ')],
    };
    log.time(status);

    const finalUrl = await driver.gotoURL(passContext.url, {
      waitForFCP: passContext.passConfig.recordTrace,
      waitForLoad: true,
      passContext,
    });
    passContext.url = finalUrl;

    log.timeEnd(status);
  }

  /**
   * @param {Driver} driver
   * @param {{requestedUrl: string, settings: LH.Config.Settings}} options
   * @return {Promise<void>}
   */
  static async setupDriver(driver, options) {
    const status = {msg: 'Initializing…', id: 'lh:gather:setupDriver'};
    log.time(status);
    const resetStorage = !options.settings.disableStorageReset;
    await driver.assertNoSameOriginServiceWorkerClients(options.requestedUrl);
    await driver.beginEmulation(options.settings);
    await driver.enableRuntimeEvents();
    await driver.enableAsyncStacks();
    await driver.cacheNatives();
    await driver.registerPerformanceObserver();
    await driver.dismissJavaScriptDialogs();
    if (resetStorage) await driver.clearDataForOrigin(options.requestedUrl);
    log.timeEnd(status);
  }

  /**
   * @param {Driver} driver
   * @return {Promise<void>}
   */
  static async disposeDriver(driver) {
    const status = {msg: 'Disconnecting from browser...', id: 'lh:gather:disconnect'};

    log.time(status);
    try {
      await driver.disconnect();
    } catch (err) {
      // Ignore disconnecting error if browser was already closed.
      // See https://github.com/GoogleChrome/lighthouse/issues/1583
      if (!(/close\/.*status: (500|404)$/.test(err.message))) {
        log.error('GatherRunner disconnect', err.message);
      }
    }
    log.timeEnd(status);
  }

  /**
   * Returns an error if the original network request failed or wasn't found.
   * @param {string} url The URL of the original requested page.
   * @param {Array<LH.Artifacts.NetworkRequest>} networkRecords
   * @return {LHError|undefined}
   */
  static getPageLoadError(url, networkRecords) {
    const mainRecord = networkRecords.find(record => {
      // record.url is actual request url, so needs to be compared without any URL fragment.
      return URL.equalWithExcludedFragments(record.url, url);
    });

    if (!mainRecord) {
      return new LHError(LHError.errors.NO_DOCUMENT_REQUEST);
    } else if (mainRecord.failed) {
      const netErr = mainRecord.localizedFailDescription;
      // Match all resolution and DNS failures
      // https://cs.chromium.org/chromium/src/net/base/net_error_list.h?rcl=cd62979b
      if (
        netErr === 'net::ERR_NAME_NOT_RESOLVED' ||
        netErr === 'net::ERR_NAME_RESOLUTION_FAILED' ||
        netErr.startsWith('net::ERR_DNS_')
      ) {
        return new LHError(LHError.errors.DNS_FAILURE);
      } else {
        return new LHError(
          LHError.errors.FAILED_DOCUMENT_REQUEST,
          {errorDetails: netErr}
        );
      }
    } else if (mainRecord.hasErrorStatusCode()) {
      return new LHError(
        LHError.errors.ERRORED_DOCUMENT_REQUEST,
        {statusCode: `${mainRecord.statusCode}`}
      );
    }
  }

  /**
   * Initialize network settings for the pass, e.g. throttling, blocked URLs,
   * and manual request headers.
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<void>}
   */
  static async setupPassNetwork(passContext) {
    const passConfig = passContext.passConfig;
    await passContext.driver.setThrottling(passContext.settings, passConfig);

    const blockedUrls = (passContext.passConfig.blockedUrlPatterns || [])
      .concat(passContext.settings.blockedUrlPatterns || []);

    // Set request blocking before any network activity
    // No "clearing" is done at the end of the pass since blockUrlPatterns([]) will unset all if
    // neccessary at the beginning of the next pass.
    await passContext.driver.blockUrlPatterns(blockedUrls);
    await passContext.driver.setExtraHTTPHeaders(passContext.settings.extraHeaders);
  }

  /**
   * Beging recording devtoolsLog and trace (if requested).
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<void>}
   */
  static async beginRecording(passContext) {
    const {driver, passConfig, settings} = passContext;

    // Always record devtoolsLog
    await driver.beginDevtoolsLog();

    if (passConfig.recordTrace) {
      await driver.beginTrace(settings);
    }
  }

  /**
   * End recording devtoolsLog and trace (if requested).
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<LH.Gatherer.LoadData>}
   */
  static async endRecording(passContext) {
    const {driver, passConfig} = passContext;

    let trace;
    if (passConfig.recordTrace) {
      const status = {msg: 'Retrieving trace', id: `lh:gather:getTrace`};
      log.time(status);
      trace = await driver.endTrace();
      log.timeEnd(status);
    }

    const status = {
      msg: 'Retrieving devtoolsLog & network records',
      id: `lh:gather:getDevtoolsLog`,
    };
    log.time(status);
    const devtoolsLog = driver.endDevtoolsLog();
    const networkRecords = NetworkRecorder.recordsFromLogs(devtoolsLog);
    log.timeEnd(status);

    return {
      networkRecords,
      devtoolsLog,
      trace,
    };
  }

  /**
   * Calls beforePass() on gatherers before tracing
   * has started and before navigation to the target page.
   * @param {LH.Gatherer.PassContext} passContext
   * @param {Partial<GathererResults>} gathererResults
   * @return {Promise<void>}
   */
  static async beforePass(passContext, gathererResults) {
    const bpStatus = {msg: `Running beforePass methods`, id: `lh:gather:beforePass`};
    log.time(bpStatus, 'verbose');

    for (const gathererDefn of passContext.passConfig.gatherers) {
      const gatherer = gathererDefn.instance;
      // Abuse the passContext to pass through gatherer options
      passContext.options = gathererDefn.options || {};
      const status = {
        msg: `Retrieving setup: ${gatherer.name}`,
        id: `lh:gather:beforePass:${gatherer.name}`,
      };
      log.time(status, 'verbose');
      const artifactPromise = Promise.resolve().then(_ => gatherer.beforePass(passContext));
      gathererResults[gatherer.name] = [artifactPromise];
      await artifactPromise.catch(() => {});
      log.timeEnd(status);
    }
    log.timeEnd(bpStatus);
  }

  /**
   * Run pass() on gatherers.
   * @param {LH.Gatherer.PassContext} passContext
   * @param {Partial<GathererResults>} gathererResults
   * @return {Promise<void>}
   */
  static async pass(passContext, gathererResults) {
    const config = passContext.passConfig;
    const gatherers = config.gatherers;

    const pStatus = {msg: `Running pass methods`, id: `lh:gather:pass`};
    log.time(pStatus, 'verbose');

    for (const gathererDefn of gatherers) {
      const gatherer = gathererDefn.instance;
      // Abuse the passContext to pass through gatherer options
      passContext.options = gathererDefn.options || {};
      const status = {
        msg: `Retrieving in-page: ${gatherer.name}`,
        id: `lh:gather:pass:${gatherer.name}`,
      };
      log.time(status);
      const artifactPromise = Promise.resolve().then(_ => gatherer.pass(passContext));

      const gathererResult = gathererResults[gatherer.name] || [];
      gathererResult.push(artifactPromise);
      gathererResults[gatherer.name] = gathererResult;
      await artifactPromise.catch(() => {});
    }

    log.timeEnd(pStatus);
  }

  /**
   * Ends tracing and collects trace data (if requested for this pass), and runs
   * afterPass() on gatherers with trace data passed in. Promise resolves with
   * object containing trace and network data.
   * @param {LH.Gatherer.PassContext} passContext
   * @param {LH.Gatherer.LoadData} loadData
   * @param {Partial<GathererResults>} gathererResults
   * @return {Promise<void>}
   */
  static async afterPass(passContext, loadData, gathererResults) {
    const config = passContext.passConfig;
    const gatherers = config.gatherers;

    const apStatus = {msg: `Running afterPass methods`, id: `lh:gather:afterPass`};
    log.time(apStatus, 'verbose');

    for (const gathererDefn of gatherers) {
      const gatherer = gathererDefn.instance;
      const status = {
        msg: `Retrieving: ${gatherer.name}`,
        id: `lh:gather:afterPass:${gatherer.name}`,
      };
      log.time(status);

      // Add gatherer options to the passContext.
      passContext.options = gathererDefn.options || {};
      const artifactPromise = Promise.resolve()
        .then(_ => gatherer.afterPass(passContext, loadData));

      const gathererResult = gathererResults[gatherer.name] || [];
      gathererResult.push(artifactPromise);
      gathererResults[gatherer.name] = gathererResult;
      await artifactPromise.catch(() => {});
      log.timeEnd(status);
    }
    log.timeEnd(apStatus);
  }

  /**
   * @param {LH.Gatherer.PassContext} passContext
   * @param {LHError} pageLoadError
   * @param {Partial<GathererResults>} gathererResults
   * @return {Promise<void>}
   */
  static async fillWithPageLoadErrors(passContext, pageLoadError, gathererResults) {
    // Fail every gatherer's afterPass with the pageLoadError.
    for (const gathererDefn of passContext.passConfig.gatherers) {
      const gatherer = gathererDefn.instance;
      const artifactPromise = Promise.reject(pageLoadError);
      const gathererResult = gathererResults[gatherer.name] || [];
      gathererResult.push(artifactPromise);
      gathererResults[gatherer.name] = gathererResult;
      await artifactPromise.catch(() => {});
    }
  }

  /**
   * Takes the results of each gatherer phase for each gatherer and uses the
   * last produced value (that's not undefined) as the artifact for that
   * gatherer. If an error was rejected from a gatherer phase,
   * uses that error object as the artifact instead.
   * @param {Partial<GathererResults>} gathererResults
   * @param {LH.BaseArtifacts} baseArtifacts
   * @return {Promise<LH.Artifacts>}
   */
  static async collectArtifacts(gathererResults, baseArtifacts) {
    /** @type {Partial<LH.GathererArtifacts>} */
    const gathererArtifacts = {};

    const resultsEntries = /** @type {GathererResultsEntries} */ (Object.entries(gathererResults));
    for (const [gathererName, phaseResultsPromises] of resultsEntries) {
      if (gathererArtifacts[gathererName] !== undefined) continue;

      try {
        const phaseResults = await Promise.all(phaseResultsPromises);
        // Take last defined pass result as artifact.
        const definedResults = phaseResults.filter(element => element !== undefined);
        const artifact = definedResults[definedResults.length - 1];
        // Typecast pretends artifact always provided here, but checked below for top-level `throw`.
        gathererArtifacts[gathererName] = /** @type {NonVoid<PhaseResult>} */ (artifact);
      } catch (err) {
        // Return error to runner to handle turning it into an error audit.
        gathererArtifacts[gathererName] = err;
      }

      if (gathererArtifacts[gathererName] === undefined) {
        throw new Error(`${gathererName} failed to provide an artifact.`);
      }
    }

    // Take only unique LighthouseRunWarnings.
    baseArtifacts.LighthouseRunWarnings = Array.from(new Set(baseArtifacts.LighthouseRunWarnings));

    // Take the timing entries we've gathered so far.
    baseArtifacts.Timing = log.getTimeEntries();

    // TODO(bckenny): correct Partial<LH.GathererArtifacts> at this point to drop cast.
    return /** @type {LH.Artifacts} */ ({...baseArtifacts, ...gathererArtifacts});
  }

  /**
   * @param {{driver: Driver, requestedUrl: string, settings: LH.Config.Settings}} options
   * @return {Promise<LH.BaseArtifacts>}
   */
  static async getBaseArtifacts(options) {
    const hostUserAgent = (await options.driver.getBrowserVersion()).userAgent;

    const {emulatedFormFactor} = options.settings;
    // Whether Lighthouse was run on a mobile device (i.e. not on a desktop machine).
    const IsMobileHost = hostUserAgent.includes('Android') || hostUserAgent.includes('Mobile');
    const TestedAsMobileDevice = emulatedFormFactor === 'mobile' ||
      (emulatedFormFactor !== 'desktop' && IsMobileHost);

    return {
      fetchTime: (new Date()).toJSON(),
      LighthouseRunWarnings: [],
      TestedAsMobileDevice,
      HostUserAgent: hostUserAgent,
      NetworkUserAgent: '', // updated later
      BenchmarkIndex: 0, // updated later
      WebAppManifest: null, // updated later
      Stacks: [], // updated later
      traces: {},
      devtoolsLogs: {},
      settings: options.settings,
      URL: {requestedUrl: options.requestedUrl, finalUrl: ''},
      Timing: [],
    };
  }

  /**
   * Uses the debugger protocol to fetch the manifest from within the context of
   * the target page, reusing any credentials, emulation, etc, already established
   * there.
   *
   * Returns the parsed manifest or null if the page had no manifest. If the manifest
   * was unparseable as JSON, manifest.value will be undefined and manifest.warning
   * will have the reason. See manifest-parser.js for more information.
   *
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<LH.Artifacts.Manifest|null>}
   */
  static async getWebAppManifest(passContext) {
    const response = await passContext.driver.getAppManifest();
    if (!response) return null;
    return manifestParser(response.data, response.url, passContext.url);
  }

  /**
   * @param {Array<LH.Config.Pass>} passes
   * @param {{driver: Driver, requestedUrl: string, settings: LH.Config.Settings}} options
   * @return {Promise<LH.Artifacts>}
   */
  static async run(passes, options) {
    const driver = options.driver;

    /** @type {Partial<GathererResults>} */
    const gathererResults = {};

    try {
      await driver.connect();
      const baseArtifacts = await GatherRunner.getBaseArtifacts(options);
      // In the devtools/extension case, we can't still be on the site while trying to clear state
      // So we first navigate to about:blank, then apply our emulation & setup
      await GatherRunner.loadBlank(driver);
      baseArtifacts.BenchmarkIndex = await options.driver.getBenchmarkIndex();
      await GatherRunner.setupDriver(driver, options);

      let isFirstPass = true;
      for (const passConfig of passes) {
        const passContext = {
          driver,
          // If the main document redirects, we'll update this to keep track
          url: options.requestedUrl,
          settings: options.settings,
          passConfig,
          baseArtifacts,
          // *pass() functions and gatherers can push to this warnings array.
          LighthouseRunWarnings: baseArtifacts.LighthouseRunWarnings,
        };

        if (!isFirstPass) {
          // Already on blank page if driver was just set up.
          await GatherRunner.loadBlank(driver, passConfig.blankPage);
        }

        const passResults = await GatherRunner.runPass(passContext);
        Object.assign(gathererResults, passResults);

        // TODO(bckenny): move into collect base or whatever?
        if (isFirstPass) {
          // Copy redirected URL to artifact in the first pass only.
          baseArtifacts.URL.finalUrl = passContext.url;

          // Fetch the manifest, if it exists. Currently must be fetched before `start-url` gatherer.
          baseArtifacts.WebAppManifest = await GatherRunner.getWebAppManifest(passContext);

          baseArtifacts.Stacks = await stacksGatherer(driver);

          const devtoolsLog = baseArtifacts.devtoolsLogs[passConfig.passName];
          const userAgentEntry = devtoolsLog.find(entry =>
            entry.method === 'Network.requestWillBeSent' &&
            !!entry.params.request.headers['User-Agent']
          );
          if (userAgentEntry) {
            // @ts-ignore - guaranteed to exist by the find above
            baseArtifacts.NetworkUserAgent = userAgentEntry.params.request.headers['User-Agent'];
          }

          isFirstPass = false;
        }
      }

      const resetStorage = !options.settings.disableStorageReset;
      if (resetStorage) await driver.clearDataForOrigin(options.requestedUrl);
      await GatherRunner.disposeDriver(driver);
      return GatherRunner.collectArtifacts(gathererResults, baseArtifacts);
    } catch (err) {
      // cleanup on error
      GatherRunner.disposeDriver(driver);
      throw err;
    }
  }

  /**
   * Returns whether this pass should be considered to be measuring performance.
   * @param {LH.Gatherer.PassContext} passContext
   * @return {boolean}
   */
  static isPerfPass(passContext) {
    const {settings, passConfig} = passContext;
    return !settings.disableStorageReset && passConfig.recordTrace && passConfig.useThrottling;
  }

  /**
   * Starting from about:blank, load the page and run gatherers for this pass.
   * @param {LH.Gatherer.PassContext} passContext
   * @return {Promise<Partial<GathererResults>>}
   */
  static async runPass(passContext) {
    /** @type {Partial<GathererResults>} */
    const gathererResults = {};
    const {driver, passConfig} = passContext;

    // On about:blank.
    await GatherRunner.setupPassNetwork(passContext);
    const isPerfPass = GatherRunner.isPerfPass(passContext);
    if (isPerfPass) await driver.cleanBrowserCaches(); // Clear disk & memory cache if it's a perf run
    await GatherRunner.beforePass(passContext, gathererResults);

    // Navigate.
    await GatherRunner.beginRecording(passContext);
    await GatherRunner.loadPage(driver, passContext);
    await GatherRunner.pass(passContext, gathererResults);
    const loadData = await GatherRunner.endRecording(passContext);

    // Disable throttling so the afterPass analysis isn't throttled
    await driver.setThrottling(passContext.settings, {useThrottling: false});

    // Save devtoolsLog and trace (if requested by passConfig).
    const baseArtifacts = passContext.baseArtifacts;
    baseArtifacts.devtoolsLogs[passConfig.passName] = loadData.devtoolsLog;
    if (loadData.trace) baseArtifacts.traces[passConfig.passName] = loadData.trace;

    // Check for any load errors (but if the driver was offline, ignore the expected error).
    let pageLoadError = GatherRunner.getPageLoadError(passContext.url, loadData.networkRecords);
    if (!driver.online) pageLoadError = undefined;

    // If no error, finish the afterPass and return.
    if (!pageLoadError) {
      await GatherRunner.afterPass(passContext, loadData, gathererResults);
      // TODO(bckenny): actually collect here
      return gathererResults;
    }

    // Move out of here?
    log.error('GatherRunner', pageLoadError.message, passContext.url);
    passContext.LighthouseRunWarnings.push(pageLoadError.friendlyMessage);
    await GatherRunner.fillWithPageLoadErrors(passContext, pageLoadError, gathererResults);
    // TODO(bckenny): actually collect here
    return gathererResults;
  }
}

module.exports = GatherRunner;
