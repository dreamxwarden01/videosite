//go:build linux

package hardware

// EncoderType constants for Linux hardware encoder types.
const (
	EncoderNVENC = "NVENC"
	EncoderQSV   = "QSV"
)

// FFmpegEncoderName maps encoder types to FFmpeg encoder names.
var FFmpegEncoderName = map[string]string{
	EncoderNVENC: "h264_nvenc",
	EncoderQSV:   "h264_qsv",
	EncoderSW:    "libx264",
}

// cudaHWDecodeSupported is set at startup by ProbeCUDAHWDecode.
// True means the cuda hwaccel (NVDEC) is available so FFmpeg can keep
// frames in CUDA memory for the full GPU pipeline:
//
//	NVDEC decode → scale_cuda → h264_nvenc  (frames never leave GPU).
var cudaHWDecodeSupported bool

// SetCUDAHWDecodeSupported stores the result of the startup probe.
func SetCUDAHWDecodeSupported(v bool) { cudaHWDecodeSupported = v }

// CUDAHWDecodeSupported reports whether NVDEC hardware decoding is
// available in the current FFmpeg build.
func CUDAHWDecodeSupported() bool { return cudaHWDecodeSupported }

// DetectedGPU holds info about a detected GPU for encoding.
//
// On Linux, DeviceIndex for QSV is the integer suffix of the
// /dev/dri/renderD<N> path (e.g. 128, 129) so the transcoder can
// reconstruct the device path for FFmpeg's -init_hw_device flag.
// For NVENC, DeviceIndex is the CUDA index from nvidia-smi.
type DetectedGPU struct {
	HardwareID  string
	Name        string
	EncoderType string
	DeviceIndex int
}
