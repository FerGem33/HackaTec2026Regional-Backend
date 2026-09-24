import * as cdk from "aws-cdk-lib";
import { SenseCareDemoStack } from "../lib/sensecare-demo-stack";

const app = new cdk.App();

// Esqueleto de la primera ola: no instancia recursos AWS todavia.
// No ejecutar cdk deploy con intencion de aprovisionar hasta que la ola de
// infraestructura (Hito 2 de docs/IMPLEMENTATION_ROADMAP.md) este aprobada
// por el coordinador.
new SenseCareDemoStack(app, "SenseCareDemoStack", {
  description: "SenseCare demo stack (esqueleto, sin recursos aun).",
});
