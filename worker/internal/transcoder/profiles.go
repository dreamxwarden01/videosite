package transcoder

import (
	"fmt"
	"sort"
	"time"
	"videosite-worker/internal/config"
)

// FilteredProfile is an output profile selected for transcoding.
type FilteredProfile struct {
	config.OutputProfile
	CanRemux bool // true if source matches this profile's specs
}

// FilterProfiles selects which output profiles to use based on source properties.
// Rules:
// - Skip profiles with resolution larger than source
// - If source is smaller than all profiles, use the smallest profile
// - Check remux eligibility per profile
func FilterProfiles(probe *ProbeResult, profiles []config.OutputProfile) []FilteredProfile {
	if len(profiles) == 0 {
		return nil
	}

	// Sort profiles by resolution descending
	sorted := make([]config.OutputProfile, len(profiles))
	copy(sorted, profiles)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Height > sorted[j].Height
	})

	var selected []FilteredProfile

	for _, p := range sorted {
		// Skip profiles larger than source
		if p.Height > probe.Height && p.Width > probe.Width {
			continue
		}

		canRemux := checkRemuxEligibility(probe, &p)
		selected = append(selected, FilteredProfile{
			OutputProfile: p,
			CanRemux:      canRemux,
		})
	}

	// If no profiles matched (source is smaller than all), use the smallest
	if len(selected) == 0 {
		smallest := sorted[len(sorted)-1]
		selected = append(selected, FilteredProfile{
			OutputProfile: smallest,
			CanRemux:      checkRemuxEligibility(probe, &smallest),
		})
	}

	return selected
}

// ApplyBitrateCaps applies cascading bitrate caps to the selected profiles.
//
// Profiles are processed top-to-bottom (highest resolution first). For each profile:
//   - Remux: effective bitrate = source bitrate (streams are copied verbatim).
//     This keeps master.m3u8 BANDWIDTH accurate without capping anything artificially.
//   - Top-most profile or same resolution as source: no cascading cap — use config max.
//   - Lower-resolution profiles: effective = min(config max, 70% of upper grade effective).
//
// The result is written back into FilteredProfile.VideoBitrateKbps so that
// TranscodeToHLS args and WriteMasterPlaylist BANDWIDTH are automatically consistent.
func ApplyBitrateCaps(jobID string, profiles []FilteredProfile, sourceHeight, sourceBitrateKbps int) []FilteredProfile {
	upperEffective := 0 // effective bitrate of the profile immediately above in the cascade

	for i := range profiles {
		p := &profiles[i]
		configBitrate := p.VideoBitrateKbps // original config max
		isTopLevel := upperEffective == 0
		sameResAsSource := p.Height == sourceHeight

		var effective int
		if p.CanRemux {
			// Remux copies streams verbatim — the actual output bitrate IS the source bitrate.
			// If source bitrate is unknown, fall back to config max.
			if sourceBitrateKbps > 0 {
				effective = sourceBitrateKbps
				if effective > configBitrate {
					// Guard: remux eligibility already requires source ≤ config, but be safe.
					effective = configBitrate
				}
			} else {
				effective = configBitrate
			}
		} else if isTopLevel || sameResAsSource {
			// Top of the cascade, or same resolution as source: no cascading limit.
			effective = configBitrate
		} else {
			// Cascading cap: must not exceed 70% of the grade above.
			cascadeCap := int(float64(upperEffective) * 0.7)
			if cascadeCap < configBitrate {
				effective = cascadeCap
				fmt.Printf("%s [%s] %s bitrate capped: config %dk → %dk (70%% of %s %dk)\n",
					time.Now().Format("[2006-01-02 15:04:05]"), jobID, p.Name, configBitrate, effective, profiles[i-1].Name, upperEffective)
			} else {
				effective = configBitrate
			}
		}

		p.VideoBitrateKbps = effective
		upperEffective = effective
	}

	return profiles
}

// checkRemuxEligibility checks if we can just remux (copy streams) instead of transcoding.
// Remux is possible when: same codec, similar resolution, bitrate <= target,
// source frame rate <= profile fps_limit.
func checkRemuxEligibility(probe *ProbeResult, profile *config.OutputProfile) bool {
	// Codec must match
	if probe.Codec != profile.Codec {
		return false
	}

	// Resolution must match closely (within 10%)
	heightDiff := abs(probe.Height - profile.Height)
	if float64(heightDiff)/float64(profile.Height) > 0.1 {
		return false
	}

	// Source bitrate must not exceed target
	if probe.VideoBitrateKbps > 0 && probe.VideoBitrateKbps > profile.VideoBitrateKbps {
		return false
	}

	// Source frame rate must not exceed fps_limit — remux can't downsample,
	// only a transcode can apply -r. Epsilon 0.01 absorbs ffprobe's
	// numerator/denominator rounding (e.g. 59.94 vs 60).
	if probe.FrameRate > 0 && profile.FpsLimit > 0 && probe.FrameRate > float64(profile.FpsLimit)+0.01 {
		return false
	}

	return true
}

func abs(x int) int {
	if x < 0 {
		return -x
	}
	return x
}
