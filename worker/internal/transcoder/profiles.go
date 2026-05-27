package transcoder

import (
	"fmt"
	"math"
	"sort"
	"time"
	"videosite-worker/internal/config"
)

// GOP-boost tuning. When the source has a longer GOP than the target we plan
// to encode at, we give the transcoded output a moderate bitrate bonus so the
// extra I-frames don't eat into the P-frame budget. log2 makes the boost grow
// gracefully with the tightening ratio (10s→5s and 5s→2.5s each add one unit
// of boost) and the cap prevents runaway inflation on extreme ratios. The
// bonus is always clamped to whatever per-profile ceiling already applies
// (config max, and cascade cap for non-top profiles), so the boost can never
// exceed the user's intended bandwidth for that rendition.
const (
	gopBoostPerOctave = 0.15 // +15% per doubling of GOP density
	gopBoostMax       = 0.40 // hard cap at +40%
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

// ApplyBitrateCaps applies cascading bitrate caps to the selected profiles
// and, for transcoded outputs whose target GOP is tighter than the source's,
// applies a moderate GOP-tightening bitrate boost.
//
// Profiles must already have their final per-profile GOPSeconds + CanRemux
// values populated by the caller (runTranscode does this before calling us)
// so the boost reads accurate per-profile target GOPs and the cascade sees
// the post-flip CanRemux flags.
//
// Profiles are processed top-to-bottom (highest resolution first). For each
// profile:
//   - Remux: effective bitrate = source bitrate (streams are copied verbatim).
//     This keeps master.m3u8 BANDWIDTH accurate without capping artificially.
//   - Top-most profile or same resolution as source: no cascading cap — start
//     from config max, then clamp to source bitrate (if known).
//   - Lower-resolution profiles: start from min(config max, 70% of upper
//     effective), then clamp to source bitrate.
//
// Then, for non-remux profiles where sourceGOPSec > p.GOPSeconds, the
// effective bitrate is boosted toward the per-profile ceiling — the same
// min(config, cascade) value the non-boost path would honor — so the
// cascade contract stays exact even when boosts fire. Remux profiles never
// boost; their GOP is the source GOP by construction.
//
// The result is written back into FilteredProfile.VideoBitrateKbps so that
// TranscodeToHLS args and WriteMasterPlaylist BANDWIDTH stay consistent.
func ApplyBitrateCaps(jobID string, profiles []FilteredProfile, sourceHeight, sourceBitrateKbps int, sourceGOPSec float64) []FilteredProfile {
	upperEffective := 0 // effective bitrate of the profile immediately above in the cascade

	for i := range profiles {
		p := &profiles[i]
		configBitrate := p.VideoBitrateKbps // original config max
		isTopLevel := upperEffective == 0
		sameResAsSource := p.Height == sourceHeight

		// ceiling is the highest value this profile's effective bitrate is
		// allowed to reach: config max, plus the cascade cap when applicable.
		// The boost path uses the same ceiling, which is why a boost can
		// never push a lower profile above 70% of its upper neighbor.
		ceiling := configBitrate
		if !isTopLevel && !sameResAsSource {
			cascadeCap := int(float64(upperEffective) * 0.7)
			if cascadeCap < ceiling {
				ceiling = cascadeCap
			}
		}

		var effective int
		if p.CanRemux {
			// Remux copies streams verbatim — output bitrate IS the source bitrate.
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
			effective = configBitrate
		} else {
			// Cascading cap.
			if ceiling < configBitrate {
				effective = ceiling
				fmt.Printf("%s [%s] %s bitrate capped: config %dk → %dk (70%% of %s %dk)\n",
					time.Now().Format("[2006-01-02 15:04:05]"), jobID, p.Name, configBitrate, effective, profiles[i-1].Name, upperEffective)
			} else {
				effective = configBitrate
			}
		}

		// Source-bitrate ceiling: never re-encode above the source's own bitrate.
		// Only fires when source bitrate is known AND the branch above didn't
		// already pull it down (remux already equals source; cascade is already
		// ≤ 0.7 × upper which is itself ≤ source by induction).
		if sourceBitrateKbps > 0 && effective > sourceBitrateKbps {
			fmt.Printf("%s [%s] %s bitrate capped: %dk → %dk (source bitrate)\n",
				time.Now().Format("[2006-01-02 15:04:05]"), jobID, p.Name, effective, sourceBitrateKbps)
			effective = sourceBitrateKbps
		}

		// GOP-tightening boost. Only for non-remux profiles where we have
		// usable per-profile and source GOP numbers, and the target is
		// strictly tighter than the source. Boost is capped at the same
		// ceiling the cascade uses, so this cannot violate the 70% rule for
		// lower profiles or exceed the user's config max for any profile.
		if !p.CanRemux && sourceGOPSec > 0 && p.GOPSeconds > 0 && sourceGOPSec > p.GOPSeconds && effective < ceiling {
			ratio := sourceGOPSec / p.GOPSeconds
			boost := gopBoostPerOctave * math.Log2(ratio)
			if boost > gopBoostMax {
				boost = gopBoostMax
			}
			boosted := int(float64(effective) * (1 + boost))
			if boosted > ceiling {
				boosted = ceiling
			}
			if boosted > effective {
				fmt.Printf("%s [%s] %s bitrate boosted: %dk → %dk (+%.1f%%, source GOP %.3fs → target %.3fs)\n",
					time.Now().Format("[2006-01-02 15:04:05]"), jobID, p.Name, effective, boosted, float64(boosted-effective)*100/float64(effective), sourceGOPSec, p.GOPSeconds)
				effective = boosted
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
