/**
 * Sources push PCM Int16 LE mono buffers + recording timestamp into a callback.
 * The pipeline doesn't care where the audio came from.
 */
export type PcmCallback = (pcmInt16: Buffer, recordedAtMs: number) => void;

export interface AudioSource {
  /** Stable identifier written into the daily log, e.g. "mac" / "android-{deviceId}". */
  readonly tag: string;
  /** Begin emitting PCM. Resolves once the source is ready (started, port bound, etc). */
  start(onPcm: PcmCallback): Promise<void>;
  /** Stop emitting and release resources. Idempotent. */
  stop(): Promise<void>;
}
