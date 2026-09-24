export class DeviceNotFoundError extends Error {
  constructor(public readonly deviceId: string) {
    super(`Dispositivo desconocido: ${deviceId}`);
    this.name = "DeviceNotFoundError";
  }
}
