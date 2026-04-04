package slot

import "videosite-worker/internal/hardware"

// hwDecodeAvailable returns whether the full-GPU (hardware decode) path should
// be attempted for the given encoder type.
//
//   - VideoToolbox: requires both VT hw decode and scale_vt support.
//   - Software: no hw decode path exists.
func hwDecodeAvailable(encoderType string) bool {
	switch encoderType {
	case hardware.EncoderVT:
		return hardware.VTHWDecodeSupported() && hardware.ScaleVTSupported()
	default:
		return false
	}
}
