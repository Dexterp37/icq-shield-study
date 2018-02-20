
# Request for data collection review form

**All questions are mandatory. You must receive review from a data steward peer on your responses to these questions before shipping new data collection.**

1) What questions will you answer with this data?



We will answer the following 4 questions

- Is ‘within person’ effect significant and if any internet measurement is done in future do we need longitudinal measurements on profiles to control for their within - use variation. In other words, does the variability between a users day to day quality if internet experience contributes significantly to the over variability of internet experience.

- Is 3 weeks of experiments enough time to collect 4 observations per profile (assuming they are not control nor on a slow connection) for 100% of profiles? We need multiple points to estimate variability

- How many profiles on slow connections? We do not measure goodput for such profiles and if too many are on slow connections our data set will be biased.

- Does usage remains unchanged for the profiles who will have downloads initiated in their idle background.



2) Why does Mozilla need to answer these questions?  Are there benefits for users? Do we need this information to address product or business requirements?

Connection speed is important for Firefox feature prioritization / decision making and it can provide information essential for advancing a business objective such as supporting OKRs.

In addition, a great browser experience depends very much on a reliable and speedy internet connection. There are many product features we can innovate, improve and customize based on our users internet speed. If we have a reliable, representative data set of internet speeds, we can inform our browser product decisions that improve the users experience on the internet. Moreover, we can use the data to inform public policy, ultimately improving the browsing experience for all users.

3) What alternative methods did you consider to answer these questions? Why were they not sufficient?

This is the first time something like this has been tried at Mozilla. We have proxies for bandwith (e.g. Firefox stub installer data), however, this will be an unbiased, representative data of users best internet speeds and capturing within person variability.

4) Can current instrumentation answer these questions?

No, as we don't have any built-in qualitative nor quantitative measurement about connection quality. Due to that, we have no way to establish how that quality affects the usage of Firefox features.

5) List all proposed measurements and indicate the category of data collection for each measurement, using the Firefox [data c](https://wiki.mozilla.org/Firefox/Data_Collection)[ollection ](https://wiki.mozilla.org/Firefox/Data_Collection)[categories](https://wiki.mozilla.org/Firefox/Data_Collection) on the found on the Mozilla wiki.

**Note that the data steward reviewing your request will characterize your data collection based on the highest (and most sensitive) category.**

In addition to the usual pings from SHIELD studies (generaed by the [shield-studies-addon-utils](https://github.com/mozilla/shield-studies-addon-utils)), this study is sending an additional custom ping after each measuremenet. The custom ping contains the *client id*, the *environment* and the following data in the *payload* section:

<table>
  <tr>
    <td>Measurement Description</td>
    <td>Data Collection Category</td>
    <td>Tracking Bug #</td>
  </tr>
  <tr>
    <td>reason - identifies the reason why this ping was sent, and can have the following values: progress (this is an intermediate measurement), final (this is the last measurement of the study) and error (this was triggered due to an error)</td>
    <td>Category 1 “Technical data”</td>
    <td>1432835</td>
  </tr>
  <tr>
    <td>type -  the specific error type that triggered an error ping; this is optional, only available if reason = "error"; the field can have one of the following values: wrong-status (the remote server returned an error class other than 2xx), missing-performance (the performance data for the request is not available), request-aborted (the measurement was aborted to prevent the degradation of the connection) and request-error (there was a connection error)
</td>
    <td>Category 1 “Technical data”</td>
    <td>1432835</td>
  </tr>
  <tr>
    <td>latency - the round trip time to the CDN endpoint, in milliseconds, accurate to five thousandths of a millisecond</td>
    <td>Category 1 “Technical data”</td>
    <td>1432835</td>
  </tr>
  <tr>
    <td>fileSize - the size, in bytes, of the remote sample file distributed by the CDN</td>
    <td>Category 1 “Technical data”</td>
    <td>1432835</td>
  </tr>
  <tr>
    <td>connType - the detected connection type, either slow-2g, 2g, 3g, 4g or unknown</td>
    <td>Category 1 “Technical data”</td>
    <td>1432835</td>
  </tr>
  <tr>
    <td>goodput - a vector with ordered tuples containing the time since the download started (in milliseconds, with the same precision as the latency) and the goodput in Mbps (or, more appropriately, Mibit/s);</td>
    <td>Category 1 “Technical data”</td>
    <td>1432835</td>
  </tr>
</table>

6) How long will this data be collected?  Choose one of the following:

This is scoped to a time-limited experiment/project until 4 weeks after the study is deployed.

7) What populations will you measure?

* Which release channels?

Release

* Which countries?

USA, Germany, India

* Which locales?

All locales.

* Any other filters?  Please describe in detail below.

Random 0.5% sample.
Windows only.
Only Firefox builds with e10s enabled.

8) If this data collection is default on, what is the opt-out mechanism for users?

Users can unenroll through [about:studies](http://normandy.readthedocs.io/en/latest/user/actions/opt-out-study.html#about-studies). The study is automatically terminated and uninstalled if any of the following happens:

- a slow connection is detected (goodput < 50Kbps);
- 3 weeks have passed since the start of the study;
- there was any error connecting to the CDN.

9) Please provide a general description of how you will analyze this data.

Each of the above 4 questions are a hypothesis which we will test. In the course of testing, we will also estimate baseline values (e.g. unenrollment %, % of users on slow connections etc). The goodput/latency will be described across several dimensions e.g. usage, country.

10) Where do you intend to share the results of your analysis?

Currently, we aim to keep our results internal to Mozilla, so that colleagues can review methodology and discuss results. Presumably, we will discuss in internal meetings such as Data Club, Product Club etc.
