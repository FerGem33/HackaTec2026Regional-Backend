# CareWatch — Cotización AWS reproducible

Estimación mensual para la arquitectura actual: ESP32 → Raspberry Pi 4B → AWS. La detección visual continua ocurre en la Pi; AWS recibe telemetría consolidada, eventos de anomalía y una foto puntual por caso para Amazon Bedrock.

Fecha de precios: 2026-09-23. Región de referencia: `us-east-1` (N. Virginia). Moneda: USD.

## Resumen ejecutivo

| Escenario | AWS sin llamadas | Con Connect Customer Voice + un DID de referencia | Falta sumar |
| --- | ---: | ---: | --- |
| Demo: 1 persona | $0.37 / mes | $1.35 / mes | Telefonía saliente a México, SMS opcional e impuestos. |
| Piloto: 100 personas | $30.49 / mes | $33.67 / mes | Telefonía saliente a México, SMS opcional e impuestos. |

Los dos totales son **antes** de Free Tier y créditos promocionales. La columna con Connect ya incluye 2 llamadas de un minuto para demo o 60 llamadas de un minuto para el piloto, más un número DID de referencia de $0.90/mes. No incluye el precio por minuto al destino mexicano porque depende de si el contacto es móvil/fijo, el número de origen y el producto de telefonía seleccionado en la calculadora.

## Arquitectura incluida

- AWS IoT Core: conectividad MQTT de la Raspberry Pi, mensajes y Rules Engine.
- SQS, Lambda y DynamoDB: telemetría, anomalías, casos y callbacks.
- EventBridge y Step Functions Standard: orquestación de casos y plazos.
- S3: una imagen puntual privada por anomalía, retenida 7 días.
- Amazon Bedrock: Amazon Nova Lite para análisis multimodal de la imagen puntual.
- API Gateway HTTP API, Cognito y SNS por email.
- Una alarma CloudWatch mínima para la DLQ hacia SNS.
- Amazon Connect Customer (Voice): llamada de fallback.

No incluye hardware Raspberry Pi/ESP32, electricidad, Internet, SMS, almacenamiento de video, tráfico de descarga de imágenes por usuarios, impuestos ni soporte AWS.

## Precios unitarios usados

| Servicio | Precio usado | Fuente |
| --- | ---: | --- |
| IoT Core MQTT | $1.00 / millón de mensajes | [AWS IoT Core](https://aws.amazon.com/iot-core/pricing/) |
| IoT Core conectividad | $0.08 / millón de minutos | [AWS IoT Core](https://aws.amazon.com/iot-core/pricing/) |
| IoT Rules: regla o acción | $0.15 / millón | [AWS IoT Core](https://aws.amazon.com/iot-core/pricing/) |
| SQS Standard | $0.40 / millón de solicitudes | [Amazon SQS](https://aws.amazon.com/sqs/pricing/) |
| DynamoDB on-demand | $1.25 / millón de WRU; $0.25 / millón de RRU | [Amazon DynamoDB](https://aws.amazon.com/dynamodb/pricing/) |
| Lambda x86 | $0.20 / millón de invocaciones; $0.0000166667 por GB-s | [AWS Lambda](https://aws.amazon.com/lambda/pricing/) |
| S3 Standard | $0.023 / GB-mes; PUT $0.005 / 1,000; GET $0.0004 / 1,000 | [Amazon S3](https://aws.amazon.com/s3/pricing/) |
| EventBridge custom events | $1.00 / millón de eventos | [Amazon EventBridge](https://aws.amazon.com/eventbridge/pricing/) |
| Step Functions Standard | $0.000025 por transición; 4,000 transiciones gratis/mes | [AWS Step Functions](https://aws.amazon.com/step-functions/pricing/) |
| Amazon Nova Lite | $0.06 / millón tokens de entrada; $0.24 / millón tokens de salida | [AWS Bedrock](https://aws.amazon.com/blogs/machine-learning/effective-cost-optimization-strategies-for-amazon-bedrock/) |
| API Gateway HTTP API | $1.00 / millón de solicitudes, primeros 300 millones | [API Gateway](https://aws.amazon.com/api-gateway/pricing/) |
| SNS email | $2.00 / 100,000 entregas, después de 1,000 gratis/mes | [Amazon SNS](https://aws.amazon.com/sns/faqs/) |
| CloudWatch alarma estándar | $0.10 por alarma-mes | [AWS pricing reference](https://docs.aws.amazon.com/pdfs/solutions/latest/automated-security-response-on-aws/automated-security-response-on-aws.pdf) |
| Connect Customer Voice | $0.038 por minuto de voz, más telefonía | [Amazon Connect Customer](https://aws.amazon.com/products/connect/customer/pricing/) |

Los mensajes MQTT se cobran por bloques de 5 KB. Si el payload consolidado de la Pi supera 5 KB, incrementar proporcionalmente los mensajes en la calculadora.

## Parámetros comunes

| Parámetro | Valor |
| --- | --- |
| Días por mes | 30 |
| Telemetría de Pi | 1 mensaje/minuto/Pi |
| Tamaño de MQTT | ≤ 5 KB |
| Análisis Bedrock | 2,000 tokens entrada + 300 salida por anomalía |
| Imagen | JPEG de 1 MB por anomalía |
| Retención de imagen | 7 días |
| Step Functions | 15 transiciones por caso |
| Lambda telemetría | 512 MB, 100 ms por mensaje |
| Lambda por anomalía/callback | 5 invocaciones, 512 MB, 1 s por caso |
| Lambda API | 512 MB, 100 ms por request |
| Familiares | 2 por persona; alertas por email |
| Cognito | Lite o Essentials, login directo; sin ASF, federación ni M2M |
| DLQ | 1 alarma estándar CloudWatch → SNS |

## Escenario A — Demo: una persona y su familia

### Supuestos de uso

| Medida | Valor mensual |
| --- | ---: |
| Raspberry Pi conectada | 1 |
| Telemetría | 43,200 mensajes |
| Anomalías simuladas | 20 |
| Mensajes de control/ack | 80 |
| Imágenes Bedrock | 20 |
| Familiares | 2 |
| Entregas email SNS | 40 |
| Requests API | 2,000 |
| MAU Cognito | 3 |
| Llamadas de fallback de prueba | 2 × 1 minuto |

### Parámetros para AWS Pricing Calculator

| Servicio | Configuración / uso a introducir |
| --- | --- |
| IoT Core | 1 conexión durante 43,200 min; 43,300 mensajes MQTT ≤5 KB; 43,300 reglas iniciadas y 43,300 acciones. |
| SQS | Standard: 129,660 solicitudes (send + receive + delete). |
| Lambda | `telemetryProcessor`: 43,200 inv., 512 MB, 100 ms. Funciones de caso: 100 inv., 512 MB, 1 s. `apiHandler`: 2,000 inv., 512 MB, 100 ms. |
| DynamoDB | On-demand: 86,560 WRU y 2,000 RRU; almacenamiento operativo pequeño. |
| S3 | 20 PUT, 20 GET; almacenamiento promedio 0.005 GB. |
| EventBridge | 20 custom events. |
| Step Functions Standard | 300 transiciones; entra dentro de las 4,000 gratis/mes. |
| Bedrock Nova Lite | 40,000 tokens de entrada y 6,000 de salida. |
| API Gateway HTTP | 2,000 requests. |
| Cognito | 3 MAU directos; $0 bajo el nivel gratuito de 10,000 MAU. |
| SNS | 40 emails; $0 bajo las primeras 1,000 entregas gratuitas. |
| CloudWatch | 1 alarma estándar para DLQ. |
| Connect Customer Voice | 2 minutos de voz; 1 número DID si la configuración lo requiere. Añadir la tarifa de llamada saliente a México elegida en la calculadora. |

### Resultado sin Free Tier

| Servicio | Estimación mensual |
| --- | ---: |
| IoT Core | $0.0597 |
| SQS | $0.0519 |
| DynamoDB | $0.1087 |
| Lambda | $0.0476 |
| S3 | $0.0002 |
| EventBridge | $0.0000 |
| Step Functions | $0.0000 |
| Bedrock Nova Lite | $0.0038 |
| API Gateway HTTP | $0.0020 |
| SNS email | $0.0000 |
| Alarma DLQ | $0.1000 |
| **Subtotal AWS sin llamadas** | **$0.3739** |
| Connect Customer Voice: 2 min | $0.0760 |
| DID de referencia | $0.9000 |
| **Total parcial** | **$1.3499 + telefonía México** |

## Escenario B — Piloto: 100 personas y sus familias

### Supuestos de uso

| Medida | Valor mensual |
| --- | ---: |
| Raspberry Pi conectadas | 100 |
| Telemetría | 4,320,000 mensajes |
| Anomalías visuales | 6,000 (2 por día por persona) |
| Mensajes de control/ack | 24,000 |
| Imágenes Bedrock | 6,000 |
| Familiares | 2 por persona; 300 MAU conservadores |
| Entregas email SNS | 12,000 |
| Requests API | 12,000 |
| Llamadas de fallback | 60 × 1 minuto (1% de los casos) |

### Parámetros para AWS Pricing Calculator

| Servicio | Configuración / uso a introducir |
| --- | --- |
| IoT Core | 100 conexiones durante 43,200 min cada una; 4,350,000 mensajes MQTT ≤5 KB; 4,350,000 reglas iniciadas y 4,350,000 acciones. |
| SQS | Standard: 12,978,000 solicitudes (send + receive + delete). |
| Lambda | `telemetryProcessor`: 4,320,000 inv., 512 MB, 100 ms. Funciones de caso: 30,000 inv., 512 MB, 1 s. `apiHandler`: 12,000 inv., 512 MB, 100 ms. |
| DynamoDB | On-demand: 8,688,000 WRU y 12,000 RRU. |
| S3 | 6,000 PUT, 6,000 GET; almacenamiento promedio 1.37 GB. |
| EventBridge | 6,000 custom events. |
| Step Functions Standard | 90,000 transiciones; la cotización descuenta 4,000 transiciones gratuitas. |
| Bedrock Nova Lite | 12,000,000 tokens de entrada y 1,800,000 de salida. |
| API Gateway HTTP | 12,000 requests. |
| Cognito | 300 MAU directos; $0 bajo el nivel gratuito de 10,000 MAU. |
| SNS | 12,000 emails; 1,000 gratis y 11,000 cobrables. SMS no incluido. |
| CloudWatch | 1 alarma estándar para DLQ. |
| Connect Customer Voice | 60 minutos de voz; 1 DID si aplica; añadir precio por minuto de teléfono móvil/fijo México en el campo de telefonía saliente. |

### Resultado sin Free Tier

| Servicio | Estimación mensual |
| --- | ---: |
| IoT Core | $6.0006 |
| SQS | $5.1912 |
| DynamoDB | $10.8630 |
| Lambda | $4.7324 |
| S3 | $0.0638 |
| EventBridge | $0.0060 |
| Step Functions | $2.1500 |
| Bedrock Nova Lite | $1.1520 |
| API Gateway HTTP | $0.0120 |
| SNS email | $0.2200 |
| Alarma DLQ | $0.1000 |
| **Subtotal AWS sin llamadas** | **$30.4911** |
| Connect Customer Voice: 60 min | $2.2800 |
| DID de referencia | $0.9000 |
| **Total parcial** | **$33.6711 + telefonía México** |

## Variables que pueden cambiar el costo

- **SMS y llamadas:** son el principal costo incierto. Configurar en la calculadora país, fijo/móvil, número de origen y minutos reales. No asumir que la tarifa base de Connect incluye telefonía.
- **Falsos positivos:** cada anomalía añade una imagen, invocación Bedrock, transiciones y notificaciones. Medir la tasa del modelo local antes de extrapolar.
- **Tamaño de MQTT:** exceder 5 KB multiplica la facturación de mensajes IoT Core.
- **Imágenes vistas por familiares:** esta cotización contempla el GET de Bedrock, no descargas repetidas desde la app ni transferencia de salida a Internet.
- **CloudWatch Logs:** sólo se cotiza una alarma de DLQ; habilitar logs detallados agrega ingestión y almacenamiento.
- **Cognito:** la estimación usa login directo Lite/Essentials y menos de 10,000 MAU. No habilitar Plus, ASF, SAML/OIDC federado ni M2M sin recalcular.

## Recomendación de presupuesto

Para el hackathon, crear un AWS Budget mensual de $5 con alertas al 50%, 80% y 100%. Para un piloto de 100 personas, iniciar con $50/mes: cubre este escenario base y deja margen para variación de llamadas, SMS y pruebas.
