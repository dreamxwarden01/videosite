package transcoder

// VariantFromInit describes the completed rendition, not the dimensions planned
// for a possible re-encode. Stream copies and encoder fallbacks use this same
// finalization path, so HLS and DASH always share the output's actual metadata.
func VariantFromInit(profile FilteredProfile, initPath string) (Variant, error) {
	metadata, err := ProbeVideoInit(initPath)
	if err != nil {
		return Variant{}, err
	}
	return Variant{
		Name:             profile.Name,
		Width:            metadata.Width,
		Height:           metadata.Height,
		VideoBitrateKbps: profile.VideoBitrateKbps,
		Codecs:           metadata.Codec,
		FrameRateNum:     profile.Plan.FPSNum,
		FrameRateDen:     profile.Plan.FPSDen,
	}, nil
}
