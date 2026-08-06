/**
 * Runner protocol version — an integer, deliberately separate from the
 * release version of either binary (spec: "Kontrak API control-plane <->
 * Runner" — "Versi protokol integer, terpisah dari nomor rilis"). Bumping
 * `CURRENT` without widening `SUPPORTED_RANGE` is how the control plane
 * would roll out a breaking protocol change while old Runners keep
 * heartbeating (and thus stay visible) but stop being handed work via
 * `/claim`'s 426.
 *
 * Single source shared by both `control-plane` (enforces the range) and
 * `runner` (sends `CURRENT`), so the two can never define the range
 * differently by accident.
 */
export const CURRENT_PROTOCOL_VERSION = 1;

export const SUPPORTED_PROTOCOL_RANGE = { min: 1, max: 1 } as const;

export function isProtocolVersionSupported(version: number): boolean {
  return version >= SUPPORTED_PROTOCOL_RANGE.min && version <= SUPPORTED_PROTOCOL_RANGE.max;
}
