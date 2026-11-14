package transcoder

import (
	"fmt"
	"math"
)

// AudioTargetBitrate returns the configured AAC encoder target.
// Do not feed silence-heavy source averages back into a second lossy encode:
// quality takes priority, and actual bitrate may naturally be lower than target.
// This is not a per-packet or transport-rate guarantee.
func AudioTargetBitrate(settingsKbps int) (int64, error) {
	if settingsKbps <= 0 || uint64(settingsKbps) > uint64(math.MaxInt64/1000) {
		return 0, fmt.Errorf("audio bitrate setting is outside supported bounds")
	}
	return int64(settingsKbps) * 1000, nil
}
