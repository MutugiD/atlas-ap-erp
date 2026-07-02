import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    support_chat_smoke: {
      executor: "constant-arrival-rate",
      rate: 50,
      timeUnit: "1s",
      duration: "1m",
      preAllocatedVUs: 20,
      maxVUs: 80
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<400"],
    checks: ["rate>0.99"]
  }
};

const baseUrl = __ENV.SUPPORT_AGENT_URL || "http://localhost:3002";
const apiKey = __ENV.SUPPORT_API_KEY || "local-smoke-key";

export default function () {
  const userId = `load-user-${__VU % 10}`;
  const payload = JSON.stringify({
    userId,
    convId: `load-${__VU}-${__ITER}`,
    mode: "with_memory",
    message: "We use NetSuite, prefer Slack, and are on the Enterprise plan."
  });
  const response = http.post(`${baseUrl}/api/chat`, payload, {
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "x-org-id": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "x-principal-id": "k6",
      "x-role": "service"
    }
  });
  check(response, {
    "chat accepted": (res) => res.status === 200,
    "reply returned": (res) => String(res.body).includes("reply")
  });
  sleep(0.1);
}
