# Support Agent V2 Load Smoke Report Template

## Scenario

- Script: `tests/load/support-agent-k6.js`
- Target: 50 requests per second per API replica
- Duration: 1 minute
- Thresholds: `http_req_failed < 1%`, `http_req_duration p95 < 400ms`, `checks > 99%`

## Latest Local Result

Not executed in this workspace because Docker Desktop returned a 500 from the local Linux engine. CI is configured with Postgres and Redis service containers for the live integration portion; k6 should be run against staging or a local runtime with Docker healthy.

## Staging Sign-Off

Paste the k6 summary here for the target instance size before promoting a production release.
