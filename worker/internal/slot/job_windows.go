//go:build windows

package slot

import "videosite-worker/internal/hardware"

// hwDecodeAvailable returns whether the full-GPU (hardware decode) path should
// be attempted for the given encoder type.
//
//   - NVENC: CUDA hw decode is available only when CUDAHWDecodeSupported().
//   - AMF/QSV: hw decode is assumed available; tier-2 fallback if it fails.
//   - Software: no hw decode path exists.
func hwDecodeAvailable(encoderType string) bool {
	switch encoderType {
	case hardware.EncoderNVENC:
		return hardware.CUDAHWDecodeSupported()
	case hardware.EncoderAMF, hardware.EncoderQSV:
		return true
	default:
		return false
	}
}
