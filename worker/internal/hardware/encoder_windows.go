//go:build windows

package hardware

// EncoderType constants for Windows hardware encoder types.
const (
	EncoderNVENC = "NVENC"
	EncoderAMF   = "AMF"
	EncoderQSV   = "QSV"
)

// FFmpegEncoderName maps encoder types to FFmpeg encoder names.
var FFmpegEncoderName = map[string]string{
	EncoderNVENC: "h264_nvenc",
	EncoderAMF:   "h264_amf",
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
type DetectedGPU struct {
	HardwareID  string
	Name        string
	EncoderType string
	DeviceIndex int // FFmpeg device index: CUDA index for NVENC, adapter index for QSV/AMF
}
