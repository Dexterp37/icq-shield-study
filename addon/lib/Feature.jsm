"use strict";

const { utils: Cu } = Components;
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

// Lazy load modules that might not get called if the study
// doesn't start.
XPCOMUtils.defineLazyModuleGetters(this, {
  clearTimeout: "resource://gre/modules/Timer.jsm",
  HiddenFrame: "resource://icq-study-v1/lib/HiddenFrame.jsm",
  setTimeout: "resource://gre/modules/Timer.jsm",
  TelemetryController: "resource://gre/modules/TelemetryController.jsm",
});

// Lazy load the needed services as well.
XPCOMUtils.defineLazyServiceGetters(this, {
  CaptivePortalService: ["@mozilla.org/network/captive-portal-service;1", "nsICaptivePortalService"],
  idleService: ["@mozilla.org/widget/idleservice;1", "nsIIdleService"],
});

const EXPORTED_SYMBOLS = ["Feature"];

// The number of measurements to gather.
const NUM_MEASUREMENTS = 4;
// How distant apart our sampling should be when measuring.
const DOWNLINK_SAMPLING_MS = 500;
// How long to observe before expiring the study (3 weeks).
const OBSERVATION_DAYS_MS = 21 * 24 * 60 * 60 * 1000;

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
function inferConnectionLabel(downlinkKbps, latencyMs = null) {
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
   * The core of our study that implements the measurement logic.
   *
   * @param {variation} study info about particular client study variation.
   * @param {studyUtils} the configured studyUtils singleton.
   * @param {reasonName} string of bootstrap.js startup/shutdown reason.
   * @param {prefs} The object containing the prefs definitions.
   * @param {prefBranch} The root preferences branch name.
   * @param {log} The study logger.
   */
  constructor(variation, studyUtils, reasonName, prefs, prefBranch, log) {
    this._variation = variation;
    this._studyUtils = studyUtils;
    this._reasonName = reasonName;
    this._log = log;
    this._studyPrefs = prefs;
    this._prefBranch = prefBranch;

    this._startDateMs = getDateFromPref(this._studyPrefs.StartDate);
    if (!this._startDateMs) {
      // If there's no pref, fixup.
      this._startDateMs = Date.now();
      Services.prefs.setCharPref(this._studyPrefs.StartDate.name, `${this._startDateMs}`);
    }

    this._delayBetweenMeasurements = Services.prefs.getIntPref(this._studyPrefs.DelayBetweenMeasurements.name,
      this._studyPrefs.DelayBetweenMeasurements.defaultValue);
  }

  /**
   * Detect if the study ran for enough time (OBSERVATION_DAYS_MS). If so, bail out and
   * send the partial data. Please note that this should be taken care of by Normandy,
   * probably.
   *
   * @return {Boolean} true if enough days passed since the study was installed, false
   *         otherwise.
   */
  hasExpired() {
    return Math.abs(this._startDateMs - Date.now()) >= OBSERVATION_DAYS_MS;
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
      Services.prefs.getIntPref(this._studyPrefs.InitDelay.name, this._studyPrefs.InitDelay.defaultValue);
    this._startupTimer = setTimeout(() => {
      this._startupTimer = null;

      // Watch out for idle time windows. We need to store the time in order to remove the
      // observer at shutdown.
      this._idleTimeS = Services.prefs.getIntPref(
        this._studyPrefs.IdleWindowSizeS.name, this._studyPrefs.IdleWindowSizeS.defaultValue);
      idleService.addIdleObserver(this, this._idleTimeS);
    }, initDelay);

    // If we're in the control group, don't bother creating the frame.
    if (this._variation.name === "control") {
      this._log.debug("start - control group, bailing out");
      return;
    }

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
        /* eslint-disable-next-line no-undef */
        sendAsyncMessage("icqStudyMsg", {
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
    let contentScript = (url, samplingWindowMs) => {
      var sendMessageToParent = (name, data = {}) => {
        window.dispatchEvent(new window.CustomEvent("moz-icq-study-v1", {
          bubbles: true,
          detail: {
            name,
            data: data || {},
          },
        }));
      };

      var getConnectionType = (elapsed, downloadedBytes, latency = null) => {
        const downlinkKbps = (downloadedBytes * 8) / Math.max(elapsed, 1.0);
        return inferConnectionLabel(downlinkKbps, latency);
      };

      var measurement = {
        latency: 0,
        fileSize: 0,
        connType: "unknown",
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
          sendMessageToParent("error", { type: "wrong-status", status });
          return;
        }

        const performanceEntries = window.performance.getEntriesByType("resource").filter(e => {
          return e.initiatorType == "xmlhttprequest" &&
                 e.name == url;
        });

        if (performanceEntries.length !== 1) {
          sendMessageToParent("error", { type: "missing-performance" });
          return;
        }

        // Please note that the performance API will return a zero value for the
        // measurements if the host doesn't specify a 'Timing-Allow-Origin' response
        // header.
        const latency =
          Math.abs(performanceEntries[0].requestStart - performanceEntries[0].responseStart);

        // Notify the latency to the parent process.
        const deltaTime = window.performance.now() - requestStartMs;
        if (measurement.transferCheckpoints.length === 0) {
          // Have at least one measurement if we downloaded the file in less than
          // samplingWindowMs.
          measurement.transferCheckpoints.push([deltaTime, event.loaded]);
        }
        measurement.latency = latency;
        measurement.fileSize = event.total;
        measurement.connType = getConnectionType(deltaTime, event.loaded, latency);
        sendMessageToParent("measurement-done", measurement);
      };
      req.onprogress = (progress) => {
        var currentTime = window.performance.now();
        if ((currentTime - lastCheckpointTime) < samplingWindowMs) {
          // We want about samplingWindowMs distance between our data points.
          return;
        }

        // Bail out if we're on a slow connection.
        const deltaTime = currentTime - requestStartMs;
        const connType = getConnectionType(deltaTime, progress.loaded);
        if (connType === "slow-2g" || connType === "2g") {
          // If we're on a slow connection, bail out.
          measurement.connType = connType;
          req.abort();
          return;
        }

        // Save the data point: elapsed time since the transfer started and the amount
        // of bytes that were transferred so far.
        measurement.transferCheckpoints.push([deltaTime, progress.loaded]);
        // Update the last checkpoint time.
        lastCheckpointTime = currentTime;
      };
      req.onabort = () => sendMessageToParent("error", {
        type: "request-aborted",
        partial: measurement
      });
      req.onerror = () => sendMessageToParent("error", {
        type: "request-error",
        partial: measurement
      });

      req.send();
    };

    return "data:text/html,<meta charset='utf8'/><script>" +
           encodeURIComponent(inferConnectionLabel.toSource()) +
           "</script><script>(" +
           encodeURIComponent(contentScript.toSource()) +
           ")(" + endpointUrl.toSource() + ", " + DOWNLINK_SAMPLING_MS + ");</script>";
  }

  /**
   * Try to check if we're offline.
   * @return {Boolean} true if we're offline or behind a captive portal, false
   *         otherwise.
   */
  _offline() {
    // Services.io.offline has slowly become fairly useless over the years - it
    // no longer attempts to track the actual network state by default, but one
    // thing stays true: if it says we're offline then we are definitely not online.
    //
    // We also ask the captive portal service if we are behind a locked captive
    // portal.
    //
    // We don't check on the NetworkLinkService however, because it gave us
    // false positives in the past in a vm environment.
    try {
      if (Services.io.offline ||
          !Services.io.connectivity ||
          CaptivePortalService.state == CaptivePortalService.LOCKED_PORTAL) {
        return true;
      }
    } catch (ex) {
      this._log.warn("Could not determine network status.", ex);
    }
    return false;
  }

  /**
   * This function is called during idle time windows to perform a measurement.
   */
  async _performMeasurement() {
    this._log.debug("_performMeasurement");

    // Did we expire while the study was running?
    if (this.hasExpired()) {
      await this._studyUtils.endStudy({ reason: "expired" });
      return;
    }

    // If we're in the control group, do nothing.
    if (this._variation.name === "control") {
      this._log.debug("_performMeasurement - control group, bailing out");
      return;
    }

    // Are we online? Do we have network connectivity?
    if (this._offline()) {
      this._log.debug("_performMeasurement - offline");
      return;
    }

    // Check if enough time passed since the last download.
    const lastMeasurementDate = getDateFromPref(this._studyPrefs.LastMeasurement);
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
      Services.prefs.getCharPref(this._studyPrefs.Endpoint.name, `${this._studyPrefs.Endpoint.defaultValue}`);
    // Append a random number to the request to bypass the cache.
    endpointUrl = endpointUrl + "?" + (new Date()).getTime();

    // Generate the request and load the script in the browser.
    this._isMeasuring = true;
    const url = this._triggerRequest(endpointUrl);
    this._browser.setAttribute("src", url);

    // Set the last measurement date: we don't care if it was a failure or success,
    // as we don't want to measure more frequently than required.
    Services.prefs.setCharPref(this._studyPrefs.LastMeasurement.name, `${Date.now()}`);
  }

  /**
   * Generate a custom ping and send it along with our data,
   *
   * @param {Object} data The full or partial data to send with the ping.
   * @param {String} reason The reason for sending this ping, i.e. "progress"
   *                 or "aborted".
   */
  async _generateAndSendPing(data, reason) {
    // Send the measurement data.
    let payload = {
      reason,
      type: data.type || "",
      latency: data.latency,
      fileSize: data.fileSize,
      connType: data.connType,
      goodput: [],
    };

    let computeGoodput = (elapsedTimeMs, downloadedInBytes) => {
      const BYTES_PER_MEBIBYTE = 1048576;
      const downloadedMebibytes = downloadedInBytes / BYTES_PER_MEBIBYTE;
      const elapsedSeconds = elapsedTimeMs / 1000.0;
      return (downloadedMebibytes * 8) / elapsedSeconds;
    };

    const checkpoints = data.transferCheckpoints || [];
    for (let t of checkpoints) {
      const elapsedMs = t[0];
      payload.goodput.push([elapsedMs, computeGoodput(elapsedMs, t[1])]);
    }

    // Unfortunately, we can't simply use |this._studyUtils.telemetry| as
    // it requires our data to be in a specific format to be serialized to
    // the experiments parquet dataset.
    try {
      if (!this._studyUtils.telemetryConfig.send) {
        return;
      }
    } catch (ex) {
      this._log.error("_generateAndSendPing", ex);
    }
    const options = {addClientId: true, addEnvironment: true};
    await TelemetryController.submitExternalPing("shield-icq-v1", payload, options);
  }

  /**
   * Handles a measurement packet received from the content.
   * This builds a telemetry ping and sends it to our servers.
   *
   * @param {Object} data The measurement packet received from
   *        the content.
   */
  async _handleMeasurementComplete(data) {
    this._log.debug(`_handleMeasurementComplete`);
    this._isMeasuring = false;

    // Send the measurement data.
    const numMeasurements = incrementIntPref(this._studyPrefs.PerformedMeasurements.name);
    const isFinalMeasurement = numMeasurements >= NUM_MEASUREMENTS;
    await this._generateAndSendPing(data, isFinalMeasurement ? "final" : "progress");

    // Terminate the study if we gathered enough measurements.
    if (!isFinalMeasurement) {
      return;
    }

    // Terminate this study!
    this._studyUtils.endStudy({ reason: "ended-neutral" });
  }

  /**
   * Handles errors encountered when performing the measurement.
   */
  async _handleError(data) {
    this._log.error(`_handleError - reason ${data.reason}`);
    this._isMeasuring = false;

    // Send any partial data that we have.
    const partialData = data.partial || {};
    let payload = Cu.cloneInto(partialData, {});
    payload.type = data.type;
    await this._generateAndSendPing(payload, "error");

    // Terminate this study!
    this._studyUtils.endStudy({ reason: "ended-negative" });
  }

  /**
   * Handles a message coming from the content.
   */
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

  /**
   * Handles the idle notification.
   */
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
    if (this._frame) {
      this._frame.messageManager.removeMessageListener("icqStudyMsg", this._chromeHandler);
      this._frame = null;
      this._chromeHandler = null;
    }

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

    // Remove the preferences from this study.
    var defaultBranch = Services.prefs.getDefaultBranch(null);
    defaultBranch.deleteBranch(this._prefBranch);

    // Clean up the timer and the idle observer.
    clearTimeout(this._startupTimer);

    if (this._idleTimeS) {
      idleService.removeIdleObserver(this, this._idleTimeS);
    }

    // As a last thing, cleanup the internal frame.
    this._cleanupFrame();
  }
}

// webpack:`libraryTarget: 'this'`
this.EXPORTED_SYMBOLS = EXPORTED_SYMBOLS;
this.Feature = Feature;
