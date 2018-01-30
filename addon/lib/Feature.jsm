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
XPCOMUtils.defineLazyModuleGetter(this, "TelemetryController",
  "resource://gre/modules/TelemetryController.jsm");

// Lazy load the needed services as well.
XPCOMUtils.defineLazyServiceGetter(this, "idleService",
  "@mozilla.org/widget/idleservice;1", "nsIIdleService");

XPCOMUtils.defineLazyModuleGetter(
  this, "HiddenFrame", "resource://icq-study-v1/lib/HiddenFrame.jsm"
);

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
  // The last time a measurement was completed (in ms).
  LastMeasurement: {
    name: `${PREF_BRANCH}.lastMeasurementMs`,
    defaultValue: null,
  },
  // The distance between two consecutive measurements (in ms).
  DelayBetweenMeasurements: {
    name: `${PREF_BRANCH}.delayBetweenMeasurementsMs`,
    defaultValue: 7 * 60 * 60 * 1000, // 7 hours
  },
  // The number of measurements performed throughout the lifetime of the study.
  PerformedMeasurements: {
    name: `${PREF_BRANCH}.numPerformedMeasurements`,
    defaultValue: 0,
  },
  // The number of errors encountered during the study.
  ErrorCount: {
    name: `${PREF_BRANCH}.errorCount`,
    defaultValue: 0,
  },
};

// The number of measurements to gather.
const NUM_MEASUREMENTS = 4;
// How distant apart our sampling should be when measuring.
const DOWNLINK_SAMPLING_MS = 500;

/**
 * Load the a date from a string preference.
 * @param{Object} A preference from |STUDY_PREF|.
 * @return Milliseconds since the unix epoch or null.
 */
function getDateFromPref(pref) {
  // This needs to be stored as a string as the number is
  // too big for "getIntPref".
  const prefDate =
    Services.prefs.getCharPref(pref.name, null);
  if (prefDate === null) {
    return pref.defaultValue;
  }

  let returnValue = null;
  try {
    returnValue = parseFloat(prefDate);
  } catch (e) {
    this._log.warn(`getDateFromPref - unexpected start date ${prefDate}`);
  }
  return returnValue;
}

/**
 * Increments by 1 the value stored in a pref.
 * @param {String} pref the preference that the value is stored into.
 * @return {Number} the newly stored value.
 */
function incrementIntPref(pref) {
  const value = Services.prefs.getIntPref(pref, 0) + 1;
  Services.prefs.setIntPref(pref, value);
  return value;
}

/**
 * Try to infer the connection type from the current latency
 * and downlink speed.
 *
 * @param {Number} downlinkKbps the link bandwidth in Kbps.
 * @param {Number}[latencyMs] the link round-trip-time in milliseconds.
 * @return {String} One of "slow-2g", "2g", "3g", "4g" or "unknown".
 */
function inferConnectionLabel(downlinkKbps, latencyMs=null) {
  // The following table is derived from the values reported in the spec
  // here: https://wicg.github.io/netinfo/#effective-connection-types
  const CONNECTION_TYPES = [
    {
      minRttMs: 2000,
      maxDownlinkKbps: 50,
      label: "slow-2g",
    },
    {
      minRttMs: 1400,
      maxDownlinkKbps: 70,
      label: "2g",
    },
    {
      minRttMs: 270,
      maxDownlinkKbps: 700,
      label: "3g",
    },
    {
      minRttMs: 0,
      maxDownlinkKbps: 700,
      label: "4g",
    },
  ];

  for (let type of CONNECTION_TYPES) {
    if ((latencyMs !== null && latencyMs >= type.minRttMs) ||
        (downlinkKbps <= type.maxDownlinkKbps)) {
      return type.label;
    }
  }

  return "unknown";
}

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

    this._startDateMs = getDateFromPref(STUDY_PREFS.StartDate);
    if (!this._startDateMs) {
      // If there's no pref, fixup.
      this._startDateMs = Date.now();
      // TODO: uncomment below.
      // Services.prefs.setCharPref(STUDY_PREFS.StartDate.pref this._startDateMs);
    }

    this._delayBetweenMeasurements = Services.prefs.getIntPref(STUDY_PREFS.DelayBetweenMeasurements.name,
      STUDY_PREFS.DelayBetweenMeasurements.defaultValue);
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
      this._startupTimer = null;

      // Watch out for idle time windows. We need to store the time in order to remove the
      // observer at shutdown.
      this._idleTimeS = Services.prefs.getIntPref(
        STUDY_PREFS.IdleWindowSizeS.name, STUDY_PREFS.IdleWindowSizeS.defaultValue);
      idleService.addIdleObserver(this, this._idleTimeS);
    }, initDelay);

    await this._createFrame();
  }

  /**
   * Creates an windowless frame (and an e10s browser) to take the
   * measurements in.
   */
  async _createFrame() {
    this._hiddenFrame = new HiddenFrame();
    this._browser = await this._hiddenFrame.get().then(frame => {
      // Keep a reference to the frame for adding/removing the message listener.
      this._frame = frame;
      let doc = frame.document;

      const XUL_NS = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
      let browser = doc.createElementNS(XUL_NS, "browser");
      browser.setAttribute("type", "content");
      // We need this to be e10s enabled, as the Resource Performance API wouldn't
      // work in the parent process.
      browser.setAttribute("remote", "true");
      browser.setAttribute("disableglobalhistory", "true");
      doc.documentElement.appendChild(browser);
      return browser;
    });

    // Load the frame script into the browser to allow the measurements
    // to travel back here.
    let frameScript = () => {
      addEventListener("moz-icq-study-v1", e => {
        if (!e ||
            !("detail" in e) ||
            !("name" in e.detail) ||
            !("data" in e.detail) ||
            typeof e.detail.name !== "string" ||
            typeof e.detail.data !== "object") {
          return;
        }
        sendAsyncMessage('icqStudyMsg', {
          name: e.detail.name,
          data: e.detail.data,
        });
      }, false, true);
    };
    this._browser.messageManager.loadFrameScript(
      "data:,(" + frameScript.toSource() + ")();", true);

    // Also install an handler into the frame. Store the handler so that
    // we can properly clean up.
    this._chromeHandler = msg => this.receiveMessage(msg);
    this._frame.messageManager
      .addMessageListener("icqStudyMsg", this._chromeHandler);
  }

  /**
   * Performs the heavy lifting of the measurement by querying the endpoint.
   * This generates a content page and encodes it in a 'data:text/html' URI. The
   * page, right after loaded, will execute the embedded script to perform
   * the measurements. The content will communicate back with this add-on by
   * using CustomEvents.
   *
   * @returns {String} the encoded URI that contains a page that will perform
   *         the measurement.
   */
  _triggerRequest(endpointUrl) {
    this._log.trace(`_triggerRequest`);

    // Generate the script to run in the |this._browser| context to measure
    // the performance.
    let contentScript = (url) => {
      var sendMessageToParent = (name, data = {}) => {
        window.dispatchEvent(new window.CustomEvent("moz-icq-study-v1", {
          bubbles: true,
          detail: {
            name,
            data: data || {},
          },
        }));
      };

      var measurement = {
        latency: 0,
        fileSize: 0,
        transferCheckpoints: [],
      };
      var requestStartMs = null;
      var lastCheckpointTime = null;

      var req = new window.XMLHttpRequest();
      req.open("GET", url, true);
      req.onloadstart = (event) => {
        // This event is guaranteed to be processed before onload, so use this
        // to set the initial time values.
        requestStartMs = window.performance.now();
        lastCheckpointTime = requestStartMs;
      };
      req.onload = (event) => {
        const status = req.status;
        const statusClass = status - (status % 100);
        if (statusClass !== 200) {
          sendMessageToParent("error", { reason: "completion", status });
          return;
        }

        const performanceEntries = window.performance.getEntriesByType("resource").filter(e => {
          return e.initiatorType == "xmlhttprequest" &&
                 e.name == url;
        });

        if (performanceEntries.length !== 1) {
          sendMessageToParent("error", { reason: "performance" });
          return;
        }

        // Please note that the performance API will return a zero value for the
        // measurements if the host doesn't specify a 'Timing-Allow-Origin' response
        // header.
        const latency =
          Math.abs(performanceEntries[0].requestStart - performanceEntries[0].responseStart);

        // Notify the latency to the parent process.
        measurement.latency = latency;
        measurement.fileSize = event.total;
        sendMessageToParent("measurement-done", measurement);
      };
      req.onprogress = (progress) => {
        var currentTime = window.performance.now();
        if ((currentTime - lastCheckpointTime) < DOWNLINK_SAMPLING_MS) {
          // We want about DOWNLINK_SAMPLING_MS distance between our data points.
          return;
        }

        // TODO: bail out if we're on a slow connection.
        const deltaTime = currentTime - requestStartMs;
        const downlinkKbps = (progress.loaded * 8) / Math.max(latency, 1.0);
        console.log(inferConnectionLabel(downlinkKbps, null));

        // Save the data point: elapsed time since the transfer started and the amount
        // of bytes that were transferred so far.
        measurement.transferCheckpoints.push([deltaTime, progress.loaded]);
        // Update the last checkpoint time.
        lastCheckpointTime = currentTime;
      };
      req.onabort = () => sendMessageToParent("error", { reason: "aborted" });
      req.onerror = () => sendMessageToParent("error", { reason: "request" });

      req.send();
    };

    return "data:text/html,<script>" +
           encodeURIComponent(inferConnectionLabel.toSource()) +
           "</script><script>(" +
           encodeURIComponent(contentScript.toSource()) +
           ")(" + endpointUrl.toSource() + ");</script>";
  }

  /**
   * This function is called during idle time windows to perform a measurement.
   */
  async _performMeasurement() {
    this._log.debug("_performMeasurement");

    // Check if enough time passed since the last download.
    const lastMeasurementDate = getDateFromPref(STUDY_PREFS.LastMeasurement);
    if (lastMeasurementDate &&
        Math.abs(lastMeasurementDate - Date.now()) < this._delayBetweenMeasurements) {
      this._log.debug(`_performMeasurement - skipping idle (last measurement ${lastMeasurementDate})`);
      return;
    }

    // Bail out if a measurement is already in progress.
    if (this._isMeasuring) {
      this._log.warn("_performMeasurement - measurement in progress");
      return;
    }

    // Trigger the request.
    let endpointUrl =
      Services.prefs.getCharPref(STUDY_PREFS.Endpoint.name, `${STUDY_PREFS.Endpoint.defaultValue}`);
    // Append a random number to the request to bypass the cache.
    endpointUrl = endpointUrl + "?" + (new Date()).getTime();

    // Generate the request and load the script in the browser.
    this._isMeasuring = true;
    const url = this._triggerRequest(endpointUrl);
    this._browser.setAttribute("src", url);

    // Set the last measurement date: we don't care if it was a failure or success,
    // as we don't want to measure more frequently than required.
    Services.prefs.setCharPref(STUDY_PREFS.LastMeasurement.pref, Date.now());
  }

  /**
   * This wraps the utility to send telemetry pings from
   * the study. We don't want it to throw.
   *
   * @param {Object} payload The ping payload to send.
   */
  async _sendPing(payload) {
    this._log.debug("_sendPing");
    // Unfortunately, we can't simply use |this._studyUtils.telemetry| as
    // it requires our data to be in a specific format to be serialized to
    // the experiments parquet dataset.
    try {
      if (!this._studyUtils.telemetryConfig.send) {
        return;
      }
    } catch (ex) {
      this._log.error("_sendPing", ex);
    }
    const options = {addClientId: true, addEnvironment: true};
    await TelemetryController.submitExternalPing("shield-icq-v1", payload || {}, options);
  }

  /**
   * Handles a measurement packet received from the content.
   * This builds a telemetry ping and sends it to our servers.
   *
   * @param {Object} data The measurement packet received from
   *        the content.
   */
  _handleMeasurementComplete(data) {
    this._log.debug(`_handleMeasurementComplete`);
    this._isMeasuring = false;

    // Send the measurement data.
    let payload = {
      latency: data.latency,
      goodput: [],
    };

    let computeGoodput = (elapsedTimeMs, downloadedInBytes) => {
      const BYTES_PER_MEBIBYTE = 1048576;
      const downloadedMebibytes = downloadedInBytes / BYTES_PER_MEBIBYTE;
      const elapsedSeconds = elapsedTimeMs / 1000.0;
      return (downloadedMebibytes * 8) / elapsedSeconds;
    };

    for (let t of data.transferCheckpoints) {
      const elapsedMs = t[0];
      payload.goodput.push([elapsedMs, computeGoodput(elapsedMs, t[1])]);
    }

    this._sendPing(payload);

    // Terminate the study if we gathered enough measurements.
    const numMeasurements = incrementIntPref(STUDY_PREFS.PerformedMeasurements.name);
    if (numMeasurements < NUM_MEASUREMENTS) {
      return;
    }

    // Terminate this study!
    this._studyUtils.endStudy({ reason: "ended-neutral" });
  }

  _handleError(error) {
    this._log.error(`_handleError - reason ${error.reason}`);
    this._isMeasuring = false;

    const errorCount = incrementIntPref(STUDY_PREFS.ErrorCount.name);
    // TODO: abort the study if we fail too many times?
  }

  receiveMessage(message) {
    this._log.debug("receiveMessage - message received");
    if (!message ||
        !("data" in message) ||
        !("name" in message) ||
        typeof message.name !== "string" ||
        typeof message.data !== "object") {
      this._log.error("receiveMessage - received a malformed message.");
      return;
    }

    // Handle the incoming message
    const name = message.data.name;
    const data = message.data.data;
    this._log.debug(`receiveMessage - handling ${name}`);
    switch (name) {
      case "measurement-done":
        this._handleMeasurementComplete(data);
        break;
      case "error":
        this._handleError(data);
        break;
      default:
        this._log.error(`receiveMessage - unexpected message '${name}' received`);
    }
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
   * Cleanup the internal frame before shutting down.
   */
  _cleanupFrame() {
    // Uninstall the listener.
    this._frame.removeMessageListener("icqStudyMsg", this._chromeHandler);
    this._frame = null;
    this._chromeHandler = null;

    // Dispose of the hidden browser.
    if (this._browser !== null) {
      this._browser.remove();
      this._browser = null;
    }

    if (this._hiddenFrame) {
      this._hiddenFrame.destroy();
      this._hiddenFrame = null;
    }
  }

  /**
   * Called if the user disables the study or it gets uninstalled.
   */
  shutdown() {
    this._log.debug("shutdown");

    // Clean up the timer and the idle observer.
    clearTimeout(this._startupTimer);

    if (typeof this._idleTimeS === "number") {
      idleService.removeIdleObserver(this, this._idleTimeS);
      this._idleTimeS = null;
    }

    // TODO: Abort the current measurement request, if needed.
    /*if (this._currentRequest) {
      try {
        this._currentRequest.abort();
      } catch (e) {
        this._log.error("shutdown - failed to abort request", e);
      }
      this._currentRequest = null;
    }*/

    // As a last thing, cleanup the internal frame.
    this._cleanupFrame();

    // Remove the preferences from this study.
    // TODO: uncomment for production.
    // var defaultBranch = Services.prefs.getDefaultBranch(null);
    // defaultBranch.deleteBranch(PREF_BRANCH);
  }
}

// webpack:`libraryTarget: 'this'`
this.EXPORTED_SYMBOLS = EXPORTED_SYMBOLS;
this.Feature = Feature;
