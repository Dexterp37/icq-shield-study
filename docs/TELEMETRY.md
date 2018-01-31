# Telemetry sent by this add-on

## Usual Firefox Telemetry is unaffected.
- No change: `main` and other pings are UNAFFECTED by this add-on.
- Respects telemetry preferences.  If user has disabled telemetry, no telemetry will be sent.

##  Study-specific endings
TBD: what do cument here?

## `shield-study` pings (common to all shield-studies)
[shield-studies-addon-utils](https://github.com/mozilla/shield-studies-addon-utils) sends the usual packets.

## `shield-icq-v1` pings, specific to THIS study.
The `shield-icq-v1` ping is sent from the add-on upon:

* after a measurement is complete;
* if a measurement is aborted;
* if there's an error during a measurement.

**Measurement example**

```json
{
  "reason": "progress",
  "type": "",
  "latency": 204.16,
  "fileSize": 4194304,
  "connType": "4g",
  "goodput": [
    [
      516.02,
      62.01310026743149
    ]
  ]
}
```

**Error example**

```json
{
  "reason": "error",
  "type": "request-aborted",
  "latency": 0,
  "fileSize": 0,
  "connType": "slow-2g",
  "goodput": [
    [
      516.02,
      0.001310026743149
    ]
  ]
}
```

### Attributes

The `shield-icq-v1` ping can have the following attributes as part of its `payload`. Optional fields are marked as such where needed.

- `reason`, identifies the reason why this ping was sent, and can have the following values:
  - `progress`, this ping is an intermediate measurement;
  - `final`, this ping is the final measurement of the batch;
  - `error`, this ping is triggered by an error;
- `type`, the specific error type that triggered an `error` ping; this is *optional*, only available if `reason = "error"`; the field can have one of the following values:
  - `wrong-status`, if the remote server returned an error class other than `2xx`;
  - `missing-performance`, if the performance data for the request is not available;
  - `request-aborted`, if the measurement was aborted to prevent the degradation of the connection; any available partial measurement is sent along with this ping;
  - `request-error`, if there was a connection error; any available partial measurement is sent along with this ping;
- `latency`, the round trip time, in milliseconds, accurate to five thousandths of a millisecond (see [here](https://developer.mozilla.org/en-US/docs/Web/API/Performance/now));
- `fileSize`, the size, in bytes, of the remote sample file;
- `connType`, the detected connection type, either `slow-2g`, `2g`, `3g`, `4g` or `unknown` (see [here](http://wicg.github.io/netinfo/#effective-connection-types));
- `goodput`, a vector with ordered tuples containing the time since the download started (in milliseconds, with the same precision as the `latency`) and the [goodput](https://en.wikipedia.org/wiki/Goodput) in Mbps (or, more appropriately, Mibit/s);
