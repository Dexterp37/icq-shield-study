"use strict";

/* to use:

- Recall this file has chrome privileges
- Cu.import in this file will work for any 'general firefox things' (Services,etc)
  but NOT for addon-specific libs
*/
const { utils: Cu } = Components;
Cu.import("resource://gre/modules/AppConstants.jsm");
Cu.import("resource://gre/modules/Services.jsm");

/* eslint no-unused-vars: ["error", { "varsIgnorePattern": "(config|EXPORTED_SYMBOLS)" }]*/
var EXPORTED_SYMBOLS = ["config"];

// The preference branch we use for storing temporary data.
const PREF_BRANCH = "extensions.icqstudyv1";

var config = {
  "PreferencesBranch": PREF_BRANCH,

  // The following is a list of preferences used by the study,
  // along with their default values. We allow overriding this prefs
  // for testing purposes.
  "StudyPrefs": {
    // How long (in ms) until we can start measurements after the browser
    // started up.
    "InitDelay": {
      "name": `${PREF_BRANCH}.initDelayMs`,
      "defaultValue": 60 * 1000,
    },
    // The pref that stores the date the study was started.
    "StartDate": {
      "name": `${PREF_BRANCH}.startDateMs`,
      "defaultValue": null,
    },
    // How long (in seconds) user must be idle before we can consider measuring
    // the speed of the connection.
    "IdleWindowSizeS": {
      "name": `${PREF_BRANCH}.idleWindowS`,
      "defaultValue": 60 * 5, // 5 minutes
    },
    // The URI to use for testing the connection quality.
    "Endpoint": {
      "name": `${PREF_BRANCH}.endpoint`,
      "defaultValue": "https://icqv1.cdn.mozilla.net/1cd880ae9d0048588cb7a94e840699ec",
    },
    // The last time a measurement was completed (in ms).
    "LastMeasurement": {
      "name": `${PREF_BRANCH}.lastMeasurementMs`,
      "defaultValue": null,
    },
    // The distance between two consecutive measurements (in ms).
    "DelayBetweenMeasurements": {
      "name": `${PREF_BRANCH}.delayBetweenMeasurementsMs`,
      "defaultValue": 7 * 60 * 60 * 1000, // 7 hours
    },
    // The number of measurements performed throughout the lifetime of the study.
    "PerformedMeasurements": {
      "name": `${PREF_BRANCH}.numPerformedMeasurements`,
      "defaultValue": 0,
    },
  },

  // required STUDY key
  "study": {
    /** Required for studyUtils.setup():
      *
      * - studyName
      * - endings:
      *   - map of endingName: configuration
      * - telemetry
      *   - boolean send
      *   - boolean removeTestingFlag
      *
      * All other keys are optional.
      */

    // required keys: studyName, endings, telemetry

    // will be used activeExperiments tagging
    "studyName": "icqStudyV1",

    // The chrome resource path. This should be somehow related to the study name,
    // but it's not required to.
    "chromeResourceBasePath": "icq-study-v1",

    /** **endings**
      * - keys indicate the 'endStudy' even that opens these.
      * - urls should be static (data) or external, because they have to
      *   survive uninstall
      * - If there is no key for an endStudy reason, no url will open.
      * - usually surveys, orientations, explanations
      */
    "endings": {
      /** standard endings */
      "no-endings": {
        "url": "null",
      },
      /** User defined endings */
      "used-often": {
        "baseUrl": "http://www.example.com/?reason=used-often",
        "study_state": "ended-positive",  // neutral is default
      },
      "a-non-url-opening-ending": {
        "study_state": "ended-neutral",
        "baseUrl": null,
      },
      "introduction-leave-study": {
        "study_state": "ended-negative",
        "baseUrl": "http://www.example.com/?reason=introduction-leave-study",
      },
    },
    "telemetry": {
      "send": true, // assumed false. Actually send pings?
      "removeTestingFlag": true,  // Marks pings as testing, set true for actual release
      // TODO "onInvalid": "throw"  // invalid packet for schema?  throw||log
    },
  },

  // required LOG key
  "log": {
    // Fatal: 70, Error: 60, Warn: 50, Info: 40, Config: 30, Debug: 20, Trace: 10, All: -1,
    "studyUtils": {
      "level": "Trace",
    },
  },

  // OPTION KEYS

  // a place to put an 'isEligible' function
  // Will run only during first install attempt
  "isEligible": async function() {
    // We only support this study on Windows with e10s enabled.
    return AppConstants.platform === "win" &&
           Services.appinfo.browserTabsRemoteAutostart === true;
  },

  /**
   * We want 20% of users to be in the control group: nothing
   * should happen there.
   */
  "weightedVariations": [
    {
      "name": "control",
      "weight": 0.2,
    },
    {
      "name": "test",
      "weight": 0.8,
    },
  ],


  // Optional: relative to bootstrap.js in the xpi
  "studyUtilsPath": `./StudyUtils.jsm`,
};
