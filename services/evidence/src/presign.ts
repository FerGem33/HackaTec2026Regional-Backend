import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3 } from "./clients.js";

/**
 * Firma ContentType:"image/jpeg" como parte de la solicitud firmada: si la
 * Pi intenta subir con un Content-Type distinto, la firma deja de ser
 * valida y S3 rechaza el PUT. No hay forma de fijar un limite de tamano en
 * una URL PUT firmada por query string sin migrar a POST prefirmado con
 * politica (romperia el contrato edge existente de "PUT directo"); el
 * limite de tamano se valida despues, con HeadObject, en
 * evidenceCallbackHandlerFn.
 */
export async function presignEvidenceUpload(
  bucketName: string,
  s3Key: string,
  expiresInSeconds: number,
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: s3Key,
    ContentType: "image/jpeg",
  });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}
