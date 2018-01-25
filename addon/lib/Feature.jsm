"use strict";

const { utils: Cu } = Components;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// Lazy load modules that might not get called if the study
// doesn't start.
XPCOMUtils.defineLazyModuleGetter(this, "clearTimeout",
  "resource://gre/modules/Timer.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "setTimeout",
  "resource://gre/modules/Timer.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "PromiseUtils",
  "resource://gre/modules/PromiseUtils.jsm");
XPCOMUtils.defineLazyModuleGetter(this, "RecentWindow",
  "resource:///modules/RecentWindow.jsm");

// Lazy load the needed services as well.
XPCOMUtils.defineLazyServiceGetter(this, "idleService",
  "@mozilla.org/widget/idleservice;1", "nsIIdleService");

const EXPORTED_SYMBOLS = ["Feature"];

// The preference branch we use for storing temporary data.
const PREF_BRANCH = "extensions.icqstudyv1";

// The following is a list of preferences used by the study,
// along with their default values. We allow overriding this prefs
// for testing purposes.
const STUDY_PREFS = {
  // How long (in ms) until we can start measurements after the browser
  // started up.
  InitDelay: {
    name: `${PREF_BRANCH}.initDelayMs`,
    defaultValue: 60 * 1000,
  },
  // The pref that stores the date the study was started.
  StartDate: {
    name: `${PREF_BRANCH}.startDateMs`,
    defaultValue: Date.now(), // the current date
  },
  // How long (in seconds) user must be idle before we can consider measuring
  // the speed of the connection.
  IdleWindowSizeS: {
    name: `${PREF_BRANCH}.idleWindowS`,
    defaultValue: 60 * 5, // 5 minutes
  },
  // The URI to use for testing the connection quality.
  Endpoint: {
    name: `${PREF_BRANCH}.endpoint`,
    defaultValue: "https://somemozillauri-",
  },
};

class Feature {
  /**
   *  The core of our study that implements the measuerment logic.
   *
   *  @param {variation} study info about particular client study variation
   *  @param {studyUtils} the configured studyUtils singleton.
   *  @param {reasonName} string of bootstrap.js startup/shutdown reason
   *
   */
  constructor(variation, studyUtils, reasonName, log) {
    this._variation = variation;
    this._studyUtils = studyUtils;
    this._reasonName = reasonName;
    this._log = log;

    // We can't start measuring until some time after the study is started.
    this._canMeasure = false;

    // Load the study start date from the preferences. This needs to be stored
    // as a string as the number is too big for "getIntPref".
    const START_DATE =
      Services.prefs.getCharPref(STUDY_PREFS.StartDate.name, `${STUDY_PREFS.StartDate.defaultValue}`);
    try {
      this._startDateMs = parseFloat(START_DATE);
    } catch (e) {
      this._log.warn(`Feature.constructor - unexpected start date ${START_DATE}`);
      this._startDateMs = Date.now();
    }
  }

  /**
   * Detect if the study ran for enough time (7 days). If so, bail out and
   * send the partial data. Please not that this should be taken care of by Normandy,
   * probably.
   *
   * @return {Boolean} true if 7 days passed since the study was installed, false
   *         otherwise.
   */
  HasExpired() {
    const MAXIMUM_DAYS_IN_MS = 60 * 60 * 24 * 7 * 1000;
    return Math.abs(this._startDateMs - Date.now()) >= MAXIMUM_DAYS_IN_MS;
  }

  /**
   * Called when the study it's initialized. This happens on every restart
   * for eligible users.
   */
  async start() {
    this._log.debug("start");

    // After this timer is triggered, we will consider running measurements
    // during idle time.
    const initDelay =
      Services.prefs.getIntPref(STUDY_PREFS.InitDelay.name, STUDY_PREFS.InitDelay.defaultValue);
    this._startupTimer = setTimeout(() => {
      this._canMeasure = true;
      this._startupTimer = null;
    }, initDelay);

    // Watch out for idle time windows. We need to store the time in order to remove the
    // observer at shutdown.
    this._idleTimeS = Services.prefs.getIntPref(STUDY_PREFS.IdleWindowSizeS.name,
                                                STUDY_PREFS.IdleWindowSizeS.defaultValue);
    idleService.addIdleObserver(this, this._idleTimeS);
  }

  /**
   * Performs the heavy lifting of the measurement by querying the endpoint.
   * @throws {Error} if we couldn't find or run the pingsender
   */
  async _triggerRequest(win, endpointUrl) {
    this._log.trace(`_triggerRequest`);

    // Trigger the async XMLHttpRequest.
    let req = new win.XMLHttpRequest();
    req.open("GET", endpointUrl, true);
    req.responseType = "arraybuffer";

    // Define the handler that gets called when the request completes (regardless)
    // of the status code returned.
    let deferred = PromiseUtils.defer();
    req.onload = (event) => {
      const status = req.status;
      const statusClass = status - (status % 100);
      this._log.trace(`_triggerRequest - request completed with status ${status}`);
      if (statusClass === 200) {
        deferred.resolve();
        return;
      }
      // We got an unexpected status (4xx, 5xx, ...).
      deferred.reject();
    };

    // Define an error handler that makes |_triggerRequest| reject.
    let errorHandler = (event) => {
      // Log and make the caller reject with an error.
      this._log.error(`_triggerRequest - error making request to ${endpointUrl}: ${event.type}`);
      deferred.reject();
    };
    req.onerror = errorHandler;
    req.onabort = errorHandler;
    req.ontimeout = errorHandler;

    // Finally trigger.
    req.send();

    return deferred.promise;
  }

  /**
   * This function is called during idle time windows to perform a measurement.
   */
  async _performMeasurement() {
    this._log.debug(`_performMeasurement - _canMeasure: ${this._canMeasure}`);

    // TODO: check if enough time passed since the last download.

    // Get a reference to any non-popup window.
    let win = RecentWindow.getMostRecentBrowserWindow({ allowPopups: false });
    if (!win || !win.performance) {
      this._log.warn("_performMeasurement - no window or ResourceTiming API");
      return;
    }

    // Bail out if a request is already in progress.
    if (this._currentRequest) {
      this._log.warn("_performMeasurement - request in progress");
      return;
    }

    // Trigger the request.
    const endpointUrl = Services.prefs.getCharPref(STUDY_PREFS.Endpoint.name,
                                                   `${STUDY_PREFS.Endpoint.defaultValue}`);
    this._currentRequest = this._triggerRequest(win, endpointUrl);
    await this._currentRequest;
    this._currentRequest = null;

    // Extract the performance measurements from the window. |getEntriesByType| will
    // return a list of |PerformanceEntry|. We further narrow down the set by looking
    // for the specific request we made.
    const performanceEntries = win.performance.getEntriesByType("resource").filter(e => {
      return e.initiatorType == "xmlhttprequest" &&
             e.name == endpointUrl;
    });

    dump("\n**** DEBUG " + performanceEntries[0] + "\n");
  }

  observe(subject, topic, data) {
    this._log.trace(`observe - topic: ${topic}`);
    if (topic !== "idle") {
      // We're just looking for the "idle" topic here.
      return;
    }

    this._performMeasurement();
  }

  /**
   * Called if the user disables the study or it gets uninstalled.
   */
  shutdown() {
    this._log.debug("shutdown");

    // Clean up the timer and the idle observer.
    if (this._startupTimer) {
      clearTimeout(this._startupTimer);
      this._startupTimer = null;
    }

    if (typeof this._idleTimeS === "number") {
      idleService.removeIdleObserver(this, this._idleTimeS);
      this._idleTimeS = null;
    }

    // Abort the current measurement request, if needed.
    if (this._currentRequest) {
      try {
        this._currentRequest.abort();
      } catch (e) {
        this._log.error("shutdown - failed to abort request", e);
      }
      this._currentRequest = null;
    }

    // Remove the preferences from this study.
    // TODO: uncomment for production.
    // var defaultBranch = Services.prefs.getDefaultBranch(null);
    // defaultBranch.deleteBranch(PREF_BRANCH);
  }
}

// webpack:`libraryTarget: 'this'`
this.EXPORTED_SYMBOLS = EXPORTED_SYMBOLS;
this.Feature = Feature;
