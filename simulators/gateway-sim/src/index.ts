import {
  validateTelemetry,
  validateSensorAnomaly,
  validateVisualAnomaly,
} from "@sensecare/contracts";
import { generateTelemetry } from "./telemetryGenerator.js";
import { generatePoorAirQuality, generateTemperatureAlert } from "./sensorAnomalyGenerator.js";
import { generateVisualAnomalyFixture } from "./visualAnomalyFixture.js";
import { topicsFor } from "./topics.js";

interface CliOptions {
  deviceId: string;
  intervalMs: number;
  sensorAnomalyEveryTicks: number;
  once: boolean;
  emitVisualFixture: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    deviceId: process.env.SENSECARE_SIM_DEVICE_ID ?? "pi-demo-01",
    intervalMs: 5000,
    sensorAnomalyEveryTicks: 6,
    once: false,
    emitVisualFixture: false,
  };
  for (const arg of argv) {
    if (arg === "--once") options.once = true;
    else if (arg === "--emit-visual-fixture") options.emitVisualFixture = true;
    else if (arg.startsWith("--interval-ms=")) options.intervalMs = Number(arg.split("=")[1]);
    else if (arg.startsWith("--sensor-anomaly-every=")) {
      options.sensorAnomalyEveryTicks = Number(arg.split("=")[1]);
    } else if (arg.startsWith("--device-id=")) options.deviceId = arg.split("=")[1] ?? options.deviceId;
  }
  return options;
}

function publish(topic: string, payload: unknown): void {
  process.stdout.write(`${JSON.stringify({ topic, payload })}\n`);
}

function runTick(deviceId: string, tick: number, sensorAnomalyEveryTicks: number): void {
  const topics = topicsFor(deviceId);

  const telemetry = generateTelemetry(deviceId);
  if (!validateTelemetry(telemetry)) {
    throw new Error(`telemetria generada no paso su propio schema: ${JSON.stringify(validateTelemetry.errors)}`);
  }
  publish(topics.telemetry, telemetry);

  if (sensorAnomalyEveryTicks > 0 && tick > 0 && tick % sensorAnomalyEveryTicks === 0) {
    const anomaly =
      tick % (sensorAnomalyEveryTicks * 2) === 0
        ? generateTemperatureAlert(deviceId)
        : generatePoorAirQuality(deviceId);
    if (!validateSensorAnomaly(anomaly)) {
      throw new Error(
        `anomalia de sensor generada no paso su propio schema: ${JSON.stringify(validateSensorAnomaly.errors)}`,
      );
    }
    publish(topics.sensorAnomaly, anomaly);
  }
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.emitVisualFixture) {
    const fixture = generateVisualAnomalyFixture(options.deviceId);
    if (!validateVisualAnomaly(fixture)) {
      throw new Error(
        `fixture de anomalia visual no paso su propio schema: ${JSON.stringify(validateVisualAnomaly.errors)}`,
      );
    }
    publish(topicsFor(options.deviceId).visualAnomaly, fixture);
    process.stderr.write(
      "AVISO: evento visual emitido como fixture interno de pruebas. " +
        "El demo real usa la camara fisica de la Raspberry Pi, incluso al observar una animacion en pantalla.\n",
    );
  }

  if (options.once) {
    runTick(options.deviceId, 0, options.sensorAnomalyEveryTicks);
    return;
  }

  let tick = 0;
  const timer = setInterval(() => {
    runTick(options.deviceId, tick, options.sensorAnomalyEveryTicks);
    tick += 1;
  }, options.intervalMs);

  const shutdown = () => {
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
