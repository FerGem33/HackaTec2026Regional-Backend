import { randomUUID } from "node:crypto";
import type { VisualAnomaly } from "@sensecare/contracts";

/**
 * Fixture interno SOLO para pruebas de contrato/CLI, no para el demo.
 *
 * El demo visual real siempre debe pasar por la camara fisica de la
 * Raspberry Pi, incluso cuando observa una animacion reproducida en una
 * pantalla (ver docs/EDGE_IMPLEMENTATION_GUIDE.md). Esta funcion no debe
 * usarse para inyectar eventos visuales hacia AWS ni para el simulador web
 * de demo, que solo puede emitir telemetria/anomalias de sensor.
 */
export function generateVisualAnomalyFixture(deviceId: string): VisualAnomaly {
  return {
    eventId: randomUUID(),
    eventType: "VISUAL_ANOMALY",
    deviceId,
    occurredAt: new Date().toISOString(),
    anomalyType: "PERSON_PRONE_INACTIVE",
    confidence: 0.87,
    candidates: ["POSSIBLE_FALL", "POSSIBLE_UNCONSCIOUSNESS"],
    evidence: {
      personCount: 1,
      zone: "living_room",
      horizontalSeconds: 14,
      motionAfterSeconds: 12,
    },
    modelVersions: { pose: "pose-v1", person: "person-v1" },
  };
}
