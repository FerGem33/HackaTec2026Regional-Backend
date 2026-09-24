process.env.DEVICES_TABLE_NAME ??= "SenseCare-Devices-test";
process.env.TELEMETRY_TABLE_NAME ??= "SenseCare-Telemetry-test";
process.env.EVENT_LOG_TABLE_NAME ??= "SenseCare-EventLog-test";
process.env.OPEN_CASE_LOCKS_TABLE_NAME ??= "SenseCare-OpenCaseLocks-test";
process.env.EVENT_BUS_NAME ??= "SenseCare-test";
process.env.OPEN_CASE_LOCK_TTL_SECONDS ??= "7200";
process.env.PUBLISH_LEASE_SECONDS ??= "10";
process.env.TELEMETRY_RETENTION_DAYS ??= "60";
process.env.DEMO_TELEMETRY_QUEUE_URL ??= "https://sqs.us-east-1.amazonaws.com/123456789012/SenseCare-telemetry-test";
process.env.DEMO_SENSOR_ANOMALY_QUEUE_URL ??=
  "https://sqs.us-east-1.amazonaws.com/123456789012/SenseCare-sensor-anomaly-test";
process.env.DEMO_DEVICE_ALLOWLIST ??= "sim-room-01";
