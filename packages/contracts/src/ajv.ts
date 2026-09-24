import Ajv2020 from "ajv/dist/2020.js";
import { isValidUtcDateTime } from "./formats.js";

export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    allErrors: true,
    strict: true,
    // El "then"/"not" de commandAck.schema.json referencian "reason", que
    // ya esta declarado en las "properties" del schema padre (patron
    // if/then habitual); strictRequired de Ajv no reconoce esa herencia y
    // lo marcaria como error en modo estricto.
    strictRequired: false,
  });

  // Ajv core no valida "format" por si solo (a diferencia de ajv-formats).
  // Registramos el nombre estandar "date-time" con una verificacion propia
  // que, ademas de la forma (ya cubierta por "pattern"), rechaza fechas
  // sintacticamente validas pero inexistentes (30 de febrero, mes 13,
  // etc.). Un integrador en Python debe habilitar un FormatChecker RFC3339
  // equivalente (jsonschema.FormatChecker) para obtener la misma garantia.
  ajv.addFormat("date-time", {
    type: "string",
    validate: isValidUtcDateTime,
  });

  return ajv;
}
