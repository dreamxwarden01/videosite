package hardware

// EncoderVT is the VideoToolbox hardware encoder type (macOS Media Engine).
const EncoderVT = "VIDEOTOOLBOX"

// FFmpegEncoderName maps encoder types to FFmpeg encoder names.
var FFmpegEncoderName = map[string]string{
	EncoderVT: "h264_videotoolbox",
	EncoderSW: "libx264",
}

// vtHWDecodeSupported is set at startup by ProbeVTHWDecode.
// True means the videotoolbox hwaccel is available so FFmpeg can
// hardware-decode frames before encoding with h264_videotoolbox.
var vtHWDecodeSupported bool

// SetVTHWDecodeSupported stores the result of the startup probe.
func SetVTHWDecodeSupported(v bool) { vtHWDecodeSupported = v }

// VTHWDecodeSupported reports whether VideoToolbox hardware decoding is
// available in the current FFmpeg build.
func VTHWDecodeSupported() bool { return vtHWDecodeSupported }

// scaleVTSupported is set at startup by ProbeScaleVT.
// True means the scale_vt filter is available, enabling the full
// Media Engine pipeline: VT decode → scale_vt → h264_videotoolbox
// with no CPU frame processing at all.
var scaleVTSupported bool

// SetScaleVTSupported stores the result of the startup probe.
func SetScaleVTSupported(v bool) { scaleVTSupported = v }

// ScaleVTSupported reports whether the scale_vt filter is available.
func ScaleVTSupported() bool { return scaleVTSupported }

// DetectedEncoder holds info about a detected encoder for macOS.
type DetectedEncoder struct {
	HardwareID  string
	Name        string
	EncoderType string
	DeviceIndex int // always 0 for VideoToolbox (single VT unit)
}
