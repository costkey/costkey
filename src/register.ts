import { CostKey } from "./index.js";

CostKey.init({
  dsn: process.env["COSTKEY_DSN"],
  release: process.env["COSTKEY_RELEASE"],
  captureBody: process.env["COSTKEY_CAPTURE_BODY"] !== "false",
  debug: process.env["COSTKEY_DEBUG"] === "true",
});
