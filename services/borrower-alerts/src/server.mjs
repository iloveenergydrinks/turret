import { createAlertsService } from "./server-runtime.mjs";

const service = createAlertsService();
service.start();
process.on("SIGTERM", service.stop);
process.on("SIGINT", service.stop);
